import { access, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PACKAGE_VERSION } from '../generated/buildInfo.js';
import {
    atomicJson,
    composeArgs,
    IMAGE,
    installStdio,
    localUrl,
    probe,
    pullImage,
    type RuntimeState,
    readEnv,
    readState,
    releaseVersion,
    run,
    statePath,
    switchDocker,
    verifyDockerSelection,
    withLock,
    writeLauncher,
    writeOverride,
} from './core.js';

export const HELP = `Omada runtime — manage client stdio builds and a persistent local Docker service

  omada-runtime setup stdio --env-file PATH [--version X.Y.Z]
  omada-runtime setup docker --env-file PATH [--version X.Y.Z] [--port 3000]
  omada-runtime setup docker --compose-file PATH --project NAME --service NAME --url URL
  omada-runtime status|doctor stdio|docker
  omada-runtime update stdio|docker --version X.Y.Z|latest
  omada-runtime rollback stdio|docker

Options:
  --home PATH       Runtime state directory (default ~/.omada-mcp)
  --version X.Y.Z   Exact release (setup defaults to this CLI's version)
  --env-file PATH  Existing dotenv file; never edited or printed
  --package PATH   Local release .tgz for offline stdio installation
  --url URL        Local Streamable HTTP MCP endpoint (default http://127.0.0.1:3000/mcp)
  --port NUMBER    New Docker service's loopback port (default 3000)

Setup prints client configuration without credentials. Status verifies getServerInfo;
doctor also reads listSites to check controller access. Stdio status opens a fresh
process: reconnect existing MCP clients after update/rollback, then call getServerInfo
in that client. Docker updates verify readiness and restore the previous image on failure.
No service stop, credential wizard, client-settings edits or automatic updates are performed.
`;

export async function runCli(argv: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
            help: { type: 'boolean', short: 'h' },
            home: { type: 'string' },
            version: { type: 'string' },
            'env-file': { type: 'string' },
            'compose-file': { type: 'string' },
            project: { type: 'string' },
            service: { type: 'string' },
            url: { type: 'string' },
            port: { type: 'string' },
            package: { type: 'string' },
        },
    });
    if (values.help || argv.length === 0) {
        process.stdout.write(HELP);
        return;
    }
    const [command, mode] = positionals;
    if (positionals.length !== 2 || !['setup', 'doctor', 'status', 'update', 'rollback'].includes(command) || !['stdio', 'docker'].includes(mode)) {
        throw new Error('Use setup|doctor|status|update|rollback followed by stdio|docker. See --help.');
    }
    const allowed = new Set([
        'home',
        ...(command === 'setup'
            ? ['version', 'env-file', ...(mode === 'stdio' ? ['package'] : ['compose-file', 'project', 'service', 'url', 'port'])]
            : command === 'update'
              ? ['version', ...(mode === 'stdio' ? ['package'] : [])]
              : []),
    ]);
    for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`--${key} does not apply to ${command} ${mode}. See --help.`);
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or newer is required.');
    const home = resolve(values.home ?? join(homedir(), '.omada-mcp'));
    if (command === 'status' || command === 'doctor') {
        const state = await readState(home, mode);
        const info = await probe(state, state.current, command === 'doctor');
        emit({
            mode,
            selectedVersion: state.current.version,
            previousVersion: state.previous?.version ?? null,
            runningBuild: info,
            ...(mode === 'stdio' ? { scope: 'fresh stdio process; reconnect existing clients to verify their build' } : { url: state.url }),
            ...(command === 'doctor' ? { controllerRead: 'passed' } : {}),
        });
        return;
    }
    await withLock(home, async () => {
        if (command === 'setup') {
            try {
                await access(statePath(home, mode));
            } catch {
                await setup(home, mode as 'stdio' | 'docker', values);
                return;
            }
            throw new Error(`${mode} is already set up. Use status, update or a different --home.`);
        }
        const state = await readState(home, mode);
        if (mode === 'docker') await verifyDockerSelection(home, state);
        if (command === 'update' && !values.version) throw new Error('Update requires --version X.Y.Z or --version latest.');
        const selectedVersion = command === 'rollback' ? state.previous?.version : await releaseVersion(values.version ?? '');
        if (!selectedVersion) throw new Error('No previous version is saved for rollback.');
        if (selectedVersion === state.current.version) {
            emit({ mode, version: selectedVersion, changed: false, runningBuild: await probe(state) });
            return;
        }
        if (mode === 'stdio') {
            const target = command === 'rollback' ? state.previous : await installStdio(home, selectedVersion, values.package);
            if (!target) throw new Error('No previous version is saved for rollback.');
            const info = await probe(state, target);
            await atomicJson(statePath(home, mode), { ...state, current: target, previous: state.current });
            emit({ mode, runningBuild: info, reconnectClients: true });
        } else {
            // A pull precedes any Compose mutation, including rollback after a daemon/image-cache reset.
            const target = command === 'rollback' ? state.previous : await pullImage(selectedVersion);
            if (!target?.image) throw new Error('No previous image is saved for rollback.');
            if (command === 'rollback') await run('docker', ['image', 'inspect', target.image]);
            emit({ mode, runningBuild: await switchDocker(home, state, target) });
        }
    });
}
function emit(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function setup(home: string, mode: 'stdio' | 'docker', values: Record<string, string | boolean | undefined>): Promise<void> {
    const option = (key: string): string | undefined => (typeof values[key] === 'string' ? values[key] : undefined);
    const envFile = option('env-file') ? resolve(option('env-file') ?? '') : undefined;
    if (mode === 'stdio') {
        if (!envFile) throw new Error('Stdio setup requires --env-file PATH.');
        await readEnv(envFile);
        const target = await releaseVersion(option('version') ?? PACKAGE_VERSION);
        const current = await installStdio(home, target, option('package'));
        const state: RuntimeState = { mode, current, envFile };
        const info = await probe(state);
        const launcher = await writeLauncher(home);
        await atomicJson(statePath(home, mode), state);
        emit({ runningBuild: info, mcpServers: { omada: { command: process.execPath, args: [launcher] } } });
        return;
    }
    await run('docker', ['compose', 'version']);
    let state: RuntimeState;
    if (option('compose-file')) {
        if (envFile || option('version') || option('port'))
            throw new Error('Adoption preserves Compose settings. Omit --env-file, --version and --port; use update docker after adoption.');
        const composeFile = resolve(option('compose-file') ?? '');
        const project = option('project');
        const service = option('service');
        if (!project || !service) throw new Error('Adoption requires --project NAME and --service NAME from the existing Compose deployment.');
        const url = localUrl(option('url') ?? 'http://127.0.0.1:3000/mcp');
        // Read the resolved image in memory only; the resolved configuration may contain secrets.
        const config = JSON.parse(await run('docker', ['compose', '--project-name', project, '-f', composeFile, 'config', '--format', 'json'])) as {
            services?: Record<string, { image?: string }>;
        };
        const image = config.services?.[service]?.image;
        if (!image?.startsWith(`${IMAGE}:`) && !image?.startsWith(`${IMAGE}@sha256:`))
            throw new Error('The selected Compose service must use the Omada MCP release image.');
        const ids = await run('docker', ['compose', '--project-name', project, '-f', composeFile, 'ps', '-q', service]);
        if (!ids || ids.includes('\n')) throw new Error('Adoption requires exactly one running container for the selected Compose service.');
        const imageId = await run('docker', ['inspect', '--format', '{{.Image}}', ids]);
        const metadata = JSON.parse(await run('docker', ['image', 'inspect', imageId, '--format', '{{json .}}'])) as {
            RepoDigests?: string[];
            Config?: { Labels?: Record<string, string> };
        };
        const pinned = metadata.RepoDigests?.find((item) => item.startsWith(`${IMAGE}@sha256:`));
        const target = metadata.Config?.Labels?.['org.opencontainers.image.version'];
        if (!pinned || !target) throw new Error('Cannot identify the running release image digest/version; the deployment was not changed.');
        state = { mode, composeFile, project, service, url, current: { version: await releaseVersion(target.replace(/^v/, '')), image: pinned } };
        const info = await probe(state);
        await writeOverride(home, state, state.current);
        await atomicJson(statePath(home, mode), state);
        emit({ adopted: true, runningBuild: info, composeOverride: join(home, 'docker-override.json'), mcpServers: { omada: { url } } });
        return;
    }
    if (option('project') || option('service') || option('url')) throw new Error('--project, --service and --url require --compose-file adoption.');
    if (!envFile) throw new Error('New Docker setup requires --env-file PATH or adopt an existing --compose-file.');
    const credentials = await readEnv(envFile);
    const port = option('port') ?? '3000';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('--port must be an integer from 1 to 65535.');
    const target = await releaseVersion(option('version') ?? PACKAGE_VERSION);
    const current = await pullImage(target);
    const composeFile = join(home, 'compose.json');
    // Refuse collisions: Compose must not adopt containers belonging to another installation.
    const containers = await run('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=omada-runtime']);
    if (containers) throw new Error('Docker project omada-runtime already exists. Adopt its Compose file or use its existing --home.');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await atomicJson(composeFile, {
        services: {
            'omada-mcp': {
                image: current.image,
                restart: 'unless-stopped',
                environment: {
                    ...Object.fromEntries(
                        Object.keys(credentials)
                            .filter((key) => /^(OMADA_|MCP_)/.test(key))
                            .map((key) => [key, '${' + key + '}'])
                    ),
                    OMADA_ENV_FILE: '',
                    MCP_SERVER_USE_HTTP: 'true',
                    MCP_HTTP_BIND_ADDR: '0.0.0.0',
                    MCP_HTTP_PORT: '3000',
                    MCP_HTTP_TRANSPORT: 'stream',
                    MCP_HTTP_PATH: '/mcp',
                    MCP_HTTP_NGROK_ENABLED: 'false',
                },
                ports: [`127.0.0.1:${Number(port)}:3000`],
            },
        },
    });
    state = { mode, current, composeFile, project: 'omada-runtime', service: 'omada-mcp', url: `http://127.0.0.1:${Number(port)}/mcp`, envFile };
    await writeOverride(home, state, current);
    try {
        // Reuse readiness and recovery logic, with the same pinned image as the initial recovery target.
        const info = await switchDocker(home, state, current);
        await atomicJson(statePath(home, mode), state);
        emit({ runningBuild: info, mcpServers: { omada: { url: state.url } } });
    } catch {
        // Remove only the service this setup just created; never other Compose services or volumes.
        await run('docker', [...composeArgs(home, state), 'rm', '--stop', '--force', 'omada-mcp']).catch(() => undefined);
        await rm(statePath(home, mode), { force: true });
        throw new Error(
            'Docker setup failed verification. The new service was stopped; credentials were preserved. Check port availability and configuration.'
        );
    }
}
