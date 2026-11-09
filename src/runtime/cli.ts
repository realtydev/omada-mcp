import { access, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import { PACKAGE_VERSION } from '../generated/buildInfo.js';
import { loadCaCertificates } from '../omadaClient/httpOptions.js';
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

interface RuntimeOptions {
    home?: string;
    version?: string;
    envFile?: string;
    composeFile?: string;
    project?: string;
    service?: string;
    url?: string;
    port?: string;
    package?: string;
}

export async function runCli(argv: string[]): Promise<void> {
    const program = new Command()
        .name('omada-runtime')
        .description('Manage pinned Omada MCP builds for client stdio and a persistent local Docker service.')
        .version(PACKAGE_VERSION, '--cli-version', 'show the runtime CLI version')
        .option('--home <path>', 'runtime state directory', join(homedir(), '.omada-mcp'))
        .exitOverride()
        .configureOutput({
            writeOut: (text) => {
                process.stdout.write(text);
            },
            writeErr: () => undefined,
        })
        .addHelpText(
            'after',
            `
Examples:
  omada-runtime setup stdio --env-file /path/omada.env --version ${PACKAGE_VERSION}
  omada-runtime setup docker --env-file /path/omada.env --version ${PACKAGE_VERSION}
  omada-runtime update docker --version latest
  omada-runtime rollback docker

Status verifies getServerInfo; doctor also reads listSites. Stdio checks a fresh
process. Reconnect existing MCP clients after update/rollback and verify their build.
Docker updates verify readiness and restore the previous image on failure.
`
        );
    for (const [command, description] of [
        ['setup', 'Install a stdio build, create a Docker service or adopt existing Compose'],
        ['status', 'Verify the selected runtime through getServerInfo'],
        ['doctor', 'Verify the runtime and read-only controller access'],
        ['update', 'Install and verify an exact release, or resolve latest once'],
        ['rollback', 'Restore and verify the previous successful selection'],
    ]) {
        const parent = program
            .command(command)
            .description(description)
            .action(() => {
                throw new Error(`Choose stdio or docker: omada-runtime ${command} <mode>.`);
            });
        for (const mode of ['stdio', 'docker'] as const) {
            const child = parent.command(mode).description(`${description} (${mode})`);
            if (command === 'setup' || command === 'update') {
                if (command === 'update') child.requiredOption('--version <version>', 'exact release X.Y.Z, or latest');
                else child.option('--version <version>', `exact release X.Y.Z (default ${PACKAGE_VERSION})`);
                if (mode === 'stdio') child.option('--package <path>', 'local release archive instead of downloading');
            }
            if (command === 'setup') {
                if (mode === 'stdio') child.requiredOption('--env-file <path>', 'existing credential file, preserved without edits');
                else
                    child
                        .option('--env-file <path>', 'existing credential file for a new service')
                        .option('--port <number>', 'new service loopback port (default 3000)')
                        .option('--compose-file <path>', 'adopt an existing running Compose service')
                        .option('--project <name>', 'existing Compose project to adopt')
                        .option('--service <name>', 'existing Compose service to adopt')
                        .option('--url <url>', 'existing local MCP endpoint (default http://127.0.0.1:3000/mcp)');
            }
            child.action(async (_options, selected: Command) => {
                await executeCommand(command, mode, selected.optsWithGlobals<RuntimeOptions>());
            });
        }
    }
    if (argv.length === 0) {
        program.outputHelp();
        return;
    }
    try {
        await program.parseAsync(argv, { from: 'user' });
    } catch (error) {
        if (!(error instanceof CommanderError)) throw error;
        if (error.exitCode === 0) return;
        throw new Error(`${error.message} See omada-runtime --help.`);
    }
}

async function executeCommand(command: string, mode: 'stdio' | 'docker', values: RuntimeOptions): Promise<void> {
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
                await setup(home, mode, values);
                return;
            }
            throw new Error(`${mode} is already set up. Use status, update or a different --home.`);
        }
        const state = await readState(home, mode);
        if (mode === 'docker') await verifyDockerSelection(home, state);
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

async function setup(home: string, mode: 'stdio' | 'docker', values: RuntimeOptions): Promise<void> {
    const envFile = values.envFile ? resolve(values.envFile) : undefined;
    if (mode === 'stdio') {
        if (!envFile) throw new Error('Stdio setup requires --env-file PATH.');
        await readEnv(envFile);
        const target = await releaseVersion(values.version ?? PACKAGE_VERSION);
        const current = await installStdio(home, target, values.package);
        const state: RuntimeState = { mode, current, envFile };
        const info = await probe(state);
        const launcher = await writeLauncher(home);
        await atomicJson(statePath(home, mode), state);
        emit({ runningBuild: info, mcpServers: { omada: { command: process.execPath, args: [launcher] } } });
        return;
    }
    await run('docker', ['compose', 'version']);
    let state: RuntimeState;
    if (values.composeFile) {
        if (envFile || values.version || values.port)
            throw new Error('Adoption preserves Compose settings. Omit --env-file, --version and --port; use update docker after adoption.');
        const composeFile = resolve(values.composeFile);
        const project = values.project;
        const service = values.service;
        if (!project || !service) throw new Error('Adoption requires --project NAME and --service NAME from the existing Compose deployment.');
        const url = localUrl(values.url ?? 'http://127.0.0.1:3000/mcp');
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
        const gitCommit = metadata.Config?.Labels?.['org.opencontainers.image.revision'];
        if (!pinned || !target || !gitCommit || !/^[a-f0-9]{40}$/.test(gitCommit))
            throw new Error('Cannot identify the running release image digest/version; the deployment was not changed.');
        state = {
            mode,
            composeFile,
            project,
            service,
            url,
            current: {
                version: await releaseVersion(target.replace(/^v/, '')),
                image: pinned,
                gitCommit,
            },
        };
        const info = await probe(state);
        await writeOverride(home, state, state.current);
        await atomicJson(statePath(home, mode), state);
        emit({ adopted: true, runningBuild: info, composeOverride: join(home, 'docker-override.json'), mcpServers: { omada: { url } } });
        return;
    }
    if (values.project || values.service || values.url) throw new Error('--project, --service and --url require --compose-file adoption.');
    if (!envFile) throw new Error('New Docker setup requires --env-file PATH or adopt an existing --compose-file.');
    const credentials = await readEnv(envFile);
    const caFile = Object.hasOwn(credentials, 'OMADA_CA_FILE') ? credentials.OMADA_CA_FILE.trim() : undefined;
    const containerCaFile = '/certs/omada-ca.pem';
    if (caFile !== undefined) {
        if (!isAbsolute(caFile)) throw new Error('OMADA_CA_FILE must be an absolute path to a readable PEM certificate file for Docker setup.');
        if (credentials.OMADA_STRICT_SSL === 'false') throw new Error('OMADA_CA_FILE requires OMADA_STRICT_SSL=true');
        loadCaCertificates(caFile);
    }
    const port = values.port ?? '3000';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('--port must be an integer from 1 to 65535.');
    const target = await releaseVersion(values.version ?? PACKAGE_VERSION);
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
                    ...(caFile ? { OMADA_CA_FILE: containerCaFile } : {}),
                    OMADA_ENV_FILE: '',
                    MCP_SERVER_USE_HTTP: 'true',
                    MCP_HTTP_BIND_ADDR: '0.0.0.0',
                    MCP_HTTP_PORT: '3000',
                    MCP_HTTP_TRANSPORT: 'stream',
                    MCP_HTTP_PATH: '/mcp',
                    MCP_HTTP_NGROK_ENABLED: 'false',
                },
                ports: [`127.0.0.1:${Number(port)}:3000`],
                ...(caFile
                    ? {
                          volumes: [
                              {
                                  type: 'bind',
                                  source: resolve(caFile).replaceAll('$', () => '$$'),
                                  target: containerCaFile,
                                  read_only: true,
                              },
                          ],
                      }
                    : {}),
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
        try {
            await run('docker', [...composeArgs(home, state), 'rm', '--stop', '--force', 'omada-mcp']);
        } catch {
            await atomicJson(statePath(home, mode), state);
            throw new Error(
                'Docker setup failed and cleanup could not be confirmed. Runtime state was saved; inspect the selected Compose service and run doctor docker after restoring Docker access.'
            );
        }
        await rm(statePath(home, mode), { force: true });
        throw new Error(
            'Docker setup failed verification. The new service was stopped; credentials were preserved. Check port availability and configuration.'
        );
    }
}
