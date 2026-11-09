import { execFile } from 'node:child_process';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parse } from 'dotenv';

export const IMAGE = 'ghcr.io/realtydev/omada-mcp';
export const PACKAGE = '@realtydev/omada-mcp';
export interface BuildInfo {
    packageVersion: string;
    gitCommit: string;
    buildTime: string;
}
export interface Selection {
    version: string;
    gitCommit?: string;
    entry?: string;
    image?: string;
}
export interface RuntimeState {
    mode: 'stdio' | 'docker';
    current: Selection;
    previous?: Selection;
    envFile?: string;
    composeFile?: string;
    project?: string;
    service?: string;
    url?: string;
}
export type Runner = (command: string, args: string[], cwd?: string, environment?: Record<string, string>) => Promise<string>;
const executeFile = promisify(execFile);
export const run: Runner = async (command, args, cwd, environment) => {
    try {
        const { stdout } = await executeFile(command, args, {
            cwd,
            env: {
                ...process.env,
                ...environment,
                PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
            },
            timeout: 300_000,
            maxBuffer: 1_048_576,
            windowsHide: true,
        });
        return stdout.trim();
    } catch (error) {
        // Subprocess errors can contain complete private output; expose only the exit code.
        const code = (error as { code?: string | number }).code;
        if (code === 'ENOENT' || code === 'EACCES') throw new Error(`Cannot run ${command}. Check that it is installed and available.`);
        throw new Error(
            `${command} failed (${typeof code === 'number' ? `exit ${code}` : 'timeout or execution error'}). Check its installation, configuration and network access.`
        );
    }
};

export function version(value: string): string {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) {
        throw new Error('Use an exact version such as 0.8.0; moving tags and ranges are not supported.');
    }
    return value;
}
export async function releaseVersion(value: string): Promise<string> {
    if (value !== 'latest') return version(value);
    const response = await fetch('https://api.github.com/repos/realtydev/omada-mcp/releases/latest', { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Cannot resolve the latest release. Check network access or pass --version X.Y.Z.');
    const data = (await response.json()) as { tag_name?: string };
    return version(data.tag_name?.replace(/^v/, '') ?? '');
}
export async function atomicJson(path: string, data: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
}
export function statePath(home: string, mode: string): string {
    return join(home, `${mode}.json`);
}
export async function readState(home: string, mode: string): Promise<RuntimeState> {
    try {
        const state = JSON.parse(await readFile(statePath(home, mode), 'utf8')) as RuntimeState;
        if (state.mode !== mode || !state.current || version(state.current.version) !== state.current.version) throw new Error();
        if (mode === 'stdio' && (!state.current.entry || !state.envFile)) throw new Error();
        if (mode === 'docker' && (!state.composeFile || !state.project || !state.service || !state.url || !state.current.image)) throw new Error();
        return state;
    } catch {
        throw new Error(`No valid ${mode} setup found. Run setup ${mode} with this --home first.`);
    }
}
export async function withLock<T>(home: string, action: () => Promise<T>): Promise<T> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const lock = join(home, '.runtime-lock');
    try {
        await mkdir(lock);
    } catch {
        throw new Error(`Another runtime change is in progress. If it was interrupted, remove ${lock} after checking its owner.`);
    }
    try {
        return await action();
    } finally {
        await rm(lock, { recursive: true, force: true });
    }
}
export async function readEnv(path: string): Promise<Record<string, string>> {
    try {
        return parse(await readFile(path));
    } catch {
        throw new Error('Cannot read --env-file. Supply an existing dotenv file; its contents will be preserved.');
    }
}
export function localUrl(value: string): string {
    const url = new URL(value);
    if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error('Use a local HTTP MCP URL, for example http://127.0.0.1:3000/mcp.');
    }
    return url.href;
}
export async function probe(state: RuntimeState, selection = state.current, doctor = false): Promise<BuildInfo> {
    const client = new Client({ name: 'omada-runtime', version: '1.0.0' });
    let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
    try {
        if (state.mode === 'stdio') {
            const envFile = state.envFile;
            if (!envFile || !selection.entry) throw new Error();
            const env = await readEnv(envFile);
            const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
            transport = new StdioClientTransport({
                command: process.execPath,
                args: [selection.entry],
                cwd: dirname(selection.entry),
                env: { ...inherited, ...env, OMADA_ENV_FILE: envFile, MCP_SERVER_USE_HTTP: 'false', MCP_SERVER_LOG_LEVEL: 'error' },
                stderr: 'pipe',
            });
            transport.stderr?.on('data', () => undefined);
        } else {
            transport = new StreamableHTTPClientTransport(new URL(localUrl(state.url ?? '')));
        }
        await client.connect(transport, { timeout: 8_000 });
        const result = await client.callTool({ name: 'getServerInfo', arguments: {} }, undefined, { timeout: 8_000 });
        if (result.isError || !Array.isArray(result.content)) throw new Error();
        const part = result.content.find((item) => item.type === 'text');
        if (!part || typeof part.text !== 'string') throw new Error();
        const info = JSON.parse(part.text) as BuildInfo;
        verifyBuild(info, selection);
        if (doctor) {
            const sites = await client.callTool({ name: 'listSites', arguments: {} }, undefined, { timeout: 35_000 });
            if (sites.isError) throw new Error();
        }
        return info;
    } catch {
        throw new Error(
            `Cannot verify ${selection.version} via getServerInfo${doctor ? ' and controller listSites' : ''}. Check credentials, endpoint and runtime availability; no private response was printed.`
        );
    } finally {
        await client.close().catch(() => undefined);
        await transport?.close().catch(() => undefined);
    }
}
export async function installStdio(home: string, target: string, archive?: string, execute: Runner = run): Promise<Selection> {
    const destination = join(home, 'versions', version(target));
    const entry = join(destination, 'node_modules', PACKAGE, 'dist/index.js');
    try {
        const metadata = JSON.parse(await readFile(join(destination, 'node_modules', PACKAGE, 'package.json'), 'utf8')) as { version?: string };
        if (metadata.version === target) return await installedSelection(target, entry);
        throw new Error('Installed version metadata differs. Remove the incomplete version directory before retrying.');
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const source = archive
        ? resolve(archive)
        : `https://github.com/realtydev/omada-mcp/releases/download/v${target}/realtydev-omada-mcp-${target}.tgz`;
    try {
        await execute('npm', [
            'install',
            '--prefix',
            destination,
            '--omit=dev',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--package-lock=false',
            source,
        ]);
        const metadata = JSON.parse(await readFile(join(destination, 'node_modules', PACKAGE, 'package.json'), 'utf8')) as { version?: string };
        if (metadata.version !== target) throw new Error('Archive version does not match --version.');
        return await installedSelection(target, entry);
    } catch (error) {
        await rm(destination, { recursive: true, force: true });
        throw error;
    }
}
export function verifyBuild(info: BuildInfo, selection: Selection): void {
    if (
        info.packageVersion !== selection.version ||
        !/^[a-f0-9]{7,40}(?:-dirty)?$/.test(info.gitCommit) ||
        !Number.isFinite(Date.parse(info.buildTime)) ||
        (selection.gitCommit && selection.gitCommit !== info.gitCommit && !selection.gitCommit.startsWith(info.gitCommit))
    ) {
        throw new Error('Running build identity does not match the selected artifact.');
    }
}
async function installedSelection(target: string, entry: string): Promise<Selection> {
    await access(entry);
    const { PACKAGE_VERSION: packageVersion, GIT_COMMIT: gitCommit } = (await import(
        pathToFileURL(join(dirname(entry), 'generated/buildInfo.js')).href
    )) as { PACKAGE_VERSION?: unknown; GIT_COMMIT?: unknown };
    if (packageVersion !== target || typeof gitCommit !== 'string' || !/^[a-f0-9]{7,40}(?:-dirty)?$/.test(gitCommit)) {
        throw new Error('Installed archive has missing or mismatched build identity. Reinstall the exact release archive.');
    }
    return { version: target, entry, gitCommit };
}
export async function writeLauncher(home: string): Promise<string> {
    const path = join(home, 'stdio.mjs');
    await writeFile(
        path,
        `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const state = JSON.parse(readFileSync(${JSON.stringify(statePath(home, 'stdio'))}, 'utf8'));
const require = createRequire(state.current.entry);
const { parse } = require('dotenv');
Object.assign(process.env, parse(readFileSync(state.envFile)), { OMADA_ENV_FILE: state.envFile, MCP_SERVER_USE_HTTP: 'false' });
process.chdir(${JSON.stringify(home)});
await import(pathToFileURL(state.current.entry).href);
`,
        { mode: 0o700 }
    );
    await chmod(path, 0o700);
    return path;
}
export function composeArgs(home: string, state: RuntimeState): string[] {
    return ['compose', '--project-name', state.project ?? '', '-f', state.composeFile ?? '', '-f', join(home, 'docker-override.json')];
}
export async function writeOverride(home: string, state: RuntimeState, selection: Selection): Promise<void> {
    await atomicJson(join(home, 'docker-override.json'), { services: { [state.service ?? 'omada-mcp']: { image: selection.image } } });
}
export async function pullImage(target: string, execute: Runner = run): Promise<Selection> {
    const image = `${IMAGE}:${version(target)}`;
    try {
        await execute('docker', ['pull', image]);
    } catch {
        const { mkdtemp } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const config = await mkdtemp(join(tmpdir(), 'omada-docker-'));
        try {
            const host = process.env.DOCKER_HOST ?? (await execute('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']));
            await execute('docker', ['--host', host, '--config', config, 'pull', image]);
        } finally {
            await rm(config, { recursive: true, force: true });
        }
    }
    const metadata = JSON.parse(await execute('docker', ['image', 'inspect', image, '--format', '{{json .}}'])) as {
        RepoDigests?: string[];
        Config?: { Labels?: Record<string, string> };
    };
    const digest = metadata.RepoDigests?.find((item) => item.startsWith(`${IMAGE}@sha256:`));
    if (!digest) throw new Error('Pulled image has no registry digest; the service was not changed.');
    const gitCommit = metadata.Config?.Labels?.['org.opencontainers.image.revision'];
    if (!gitCommit || !/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error('Pulled image has no valid build revision; the service was not changed.');
    return { version: target, image: digest, gitCommit };
}
export type Prober = typeof probe;
export async function switchDocker(
    home: string,
    state: RuntimeState,
    target: Selection,
    execute: Runner = run,
    verify: Prober = probe
): Promise<BuildInfo> {
    const previous = state.current;
    await writeOverride(home, state, target);
    const args = composeArgs(home, state);
    const environment = state.envFile ? await readEnv(state.envFile) : undefined;
    const start = () =>
        environment
            ? execute('docker', [...args, 'up', '-d', '--no-deps', '--pull', 'never', state.service ?? ''], undefined, environment)
            : execute('docker', [...args, 'up', '-d', '--no-deps', '--pull', 'never', state.service ?? '']);
    try {
        await start();
        const info = await waitForBuild(state, target, verify);
        await atomicJson(statePath(home, 'docker'), { ...state, current: target, previous });
        return info;
    } catch {
        await writeOverride(home, state, previous);
        try {
            await start();
            await waitForBuild(state, previous, verify);
        } catch {
            throw new Error('Update failed and recovery could not be verified. Run doctor docker and recover with the saved Compose override.');
        }
        throw new Error('Update failed; the previous image was restored and verified.');
    }
}

async function waitForBuild(state: RuntimeState, target: Selection, verify: Prober): Promise<BuildInfo> {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            return await verify(state, target);
        } catch {
            if (attempt === 9) throw new Error('Service did not become ready.');
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        }
    }
    throw new Error('Service did not become ready.');
}
export async function verifyDockerSelection(home: string, state: RuntimeState, execute: Runner = run): Promise<void> {
    const ids = await execute('docker', [...composeArgs(home, state), 'ps', '-q', state.service ?? '']);
    if (!ids || ids.includes('\n')) throw new Error('Expected one running service container. Run doctor docker before changing versions.');
    const expected = await execute('docker', ['image', 'inspect', state.current.image ?? '', '--format', '{{.Id}}']);
    const actual = await execute('docker', ['inspect', '--format', '{{.Image}}', ids]);
    if (!expected || actual !== expected)
        throw new Error('The service image changed outside this CLI. Use a new --home to adopt its current deployment before updating.');
}
