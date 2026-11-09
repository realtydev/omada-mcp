import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/runtime/cli.js';
import * as core from '../../src/runtime/core.js';

vi.mock('../../src/runtime/core.js', async (importOriginal) => {
    const original = await importOriginal<typeof core>();
    return {
        ...original,
        probe: vi.fn(),
        installStdio: vi.fn(),
        pullImage: vi.fn(),
        switchDocker: vi.fn(),
        verifyDockerSelection: vi.fn(),
        run: vi.fn(),
    };
});
let home: string;
let envFile: string;
const old = { version: '0.6.1', entry: '/tmp/versions/0.6.1/dist/index.js', image: `${core.IMAGE}@sha256:old` };
const current = { version: '0.7.0', entry: '/tmp/versions/0.7.0/dist/index.js', image: `${core.IMAGE}@sha256:current` };
const info = { packageVersion: '0.7.0', gitCommit: 'abc123', buildTime: '2026-11-08T00:00:00Z' };
const setupState = async (mode: 'stdio' | 'docker', previous = true) => {
    const state: core.RuntimeState = {
        mode,
        current,
        ...(previous ? { previous: old } : {}),
        envFile,
        composeFile: '/tmp/compose.yaml',
        project: 'existing',
        service: 'omada-mcp',
        url: 'http://127.0.0.1:3000/mcp',
    };
    await core.atomicJson(core.statePath(home, mode), state);
    return state;
};
const cli = (command: string, mode: string, ...args: string[]) => runCli([command, mode, '--home', home, ...args]);
beforeEach(async () => {
    vi.clearAllMocks();
    home = await mkdtemp(join(tmpdir(), 'omada-cli-test-'));
    envFile = join(home, 'credentials.env');
    await writeFile(envFile, 'OMADA_CLIENT_SECRET=test-secret\n');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.mocked(core.probe).mockResolvedValue(info);
    vi.mocked(core.installStdio).mockResolvedValue(current);
    vi.mocked(core.pullImage).mockResolvedValue(current);
    vi.mocked(core.switchDocker).mockResolvedValue(info);
    vi.mocked(core.run).mockResolvedValue('');
});
afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
});

describe('runtime commands', () => {
    it('prints help and rejects missing, extra or inapplicable arguments', async () => {
        await runCli([]);
        await runCli(['--help']);
        expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('doctor'));
        for (const argv of [
            ['what', 'stdio'],
            ['status'],
            ['status', 'stdio', 'extra'],
            ['status', 'stdio', '--version', '0.7.0'],
            ['setup', 'stdio', '--port', '3000'],
            ['update', 'docker', '--package', 'x'],
        ])
            await expect(runCli(argv)).rejects.toThrow();
    });
    it('sets up stdio and prints a stable client launcher without credentials', async () => {
        await cli('setup', 'stdio', '--env-file', envFile, '--version', '0.7.0', '--package', '/tmp/local.tgz');
        expect(core.installStdio).toHaveBeenCalledWith(home, '0.7.0', '/tmp/local.tgz');
        expect(await core.readState(home, 'stdio')).toMatchObject({ current, envFile });
        const output = JSON.parse(vi.mocked(process.stdout.write).mock.calls.at(-1)?.[0] as string);
        expect(output.mcpServers.omada.args).toEqual([join(home, 'stdio.mjs')]);
        expect(JSON.stringify(output)).not.toContain('test-secret');
        await expect(cli('setup', 'stdio', '--env-file', envFile)).rejects.toThrow('already set up');
    });
    it('does not activate a failed stdio candidate', async () => {
        const state = await setupState('stdio');
        vi.mocked(core.probe).mockRejectedValueOnce(new Error('cannot verify'));
        await expect(cli('update', 'stdio', '--version', '0.8.0')).rejects.toThrow('cannot verify');
        expect(await core.readState(home, 'stdio')).toEqual(state);
        expect(await readFile(envFile, 'utf8')).toContain('test-secret');
    });
    it('requires credentials and a validated candidate before initial stdio activation', async () => {
        await expect(cli('setup', 'stdio')).rejects.toThrow('--env-file');
        vi.mocked(core.probe).mockRejectedValueOnce(new Error('cannot verify'));
        await expect(cli('setup', 'stdio', '--env-file', envFile)).rejects.toThrow('cannot verify');
        await expect(core.readState(home, 'stdio')).rejects.toThrow('setup stdio');
    });
    it('reports fresh process status and checks controller access in doctor', async () => {
        const state = await setupState('stdio');
        await cli('status', 'stdio');
        expect(core.probe).toHaveBeenLastCalledWith(state, current, false);
        await cli('doctor', 'stdio');
        expect(core.probe).toHaveBeenLastCalledWith(state, current, true);
        expect(process.stdout.write).toHaveBeenLastCalledWith(expect.stringContaining('controllerRead'));
    });
    it('requires an explicit update version and handles no-op and rollback history', async () => {
        await setupState('stdio');
        await expect(cli('update', 'stdio')).rejects.toThrow('requires --version');
        await cli('update', 'stdio', '--version', '0.7.0');
        expect(core.installStdio).not.toHaveBeenCalled();
        await cli('rollback', 'stdio');
        expect(await core.readState(home, 'stdio')).toMatchObject({ current: old, previous: current });
        await setupState('stdio', false);
        await expect(cli('rollback', 'stdio')).rejects.toThrow('No previous version');
    });
    it('updates stdio only after verification and preserves the previous build', async () => {
        const next = { version: '0.8.0', entry: '/tmp/versions/0.8.0/dist/index.js' };
        await setupState('stdio');
        vi.mocked(core.installStdio).mockResolvedValueOnce(next);
        await cli('update', 'stdio', '--version', '0.8.0');
        expect(await core.readState(home, 'stdio')).toMatchObject({ current: next, previous: current });
        expect(process.stdout.write).toHaveBeenLastCalledWith(expect.stringContaining('reconnectClients'));
    });
    it('updates and rolls back only the adopted Docker service', async () => {
        const state = await setupState('docker');
        await cli('update', 'docker', '--version', '0.8.0');
        expect(core.pullImage).toHaveBeenCalledWith('0.8.0');
        expect(core.switchDocker).toHaveBeenCalledWith(home, state, current);
        await cli('rollback', 'docker');
        expect(core.run).toHaveBeenCalledWith('docker', ['image', 'inspect', old.image]);
        expect(core.switchDocker).toHaveBeenLastCalledWith(home, state, old);
        await cli('status', 'docker');
        expect(process.stdout.write).toHaveBeenLastCalledWith(expect.stringContaining('http://127.0.0.1:3000/mcp'));
    });
    it('adopts a running pinned image without restarting it or editing its Compose file', async () => {
        const compose = join(home, 'original-compose.yaml');
        await writeFile(compose, 'original');
        vi.mocked(core.run).mockImplementation((_command, args) => {
            if (args.includes('config')) return Promise.resolve(JSON.stringify({ services: { 'omada-mcp': { image: `${core.IMAGE}:0.7.0` } } }));
            if (args.includes('ps')) return Promise.resolve('container-id');
            if (args.includes('image'))
                return Promise.resolve(
                    JSON.stringify({ RepoDigests: [current.image], Config: { Labels: { 'org.opencontainers.image.version': '0.7.0' } } })
                );
            return Promise.resolve('sha256:image');
        });
        await cli('setup', 'docker', '--compose-file', compose, '--project', 'existing', '--service', 'omada-mcp');
        expect(await core.readState(home, 'docker')).toMatchObject({ current: { version: '0.7.0', image: current.image }, project: 'existing' });
        expect(await readFile(compose, 'utf8')).toBe('original');
        expect(core.run).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['up']));
    });
    it('rejects ambiguous adoption settings and unidentifiable services', async () => {
        const base = ['--compose-file', '/tmp/compose.yaml'];
        await expect(cli('setup', 'docker', ...base, '--env-file', envFile)).rejects.toThrow('Omit');
        await expect(cli('setup', 'docker', ...base)).rejects.toThrow('--project');
        vi.mocked(core.run).mockImplementation((_command, args) => Promise.resolve(args.includes('config') ? '{"services":{}}' : ''));
        await expect(cli('setup', 'docker', ...base, '--project', 'existing', '--service', 'unknown')).rejects.toThrow('release image');
    });
    it('creates a loopback-only persistent Docker service without persisting credentials', async () => {
        await cli('setup', 'docker', '--env-file', envFile, '--port', '3017');
        const config = JSON.parse(await readFile(join(home, 'compose.json'), 'utf8'));
        expect(config.services['omada-mcp']).toMatchObject({
            restart: 'unless-stopped',
            environment: expect.objectContaining({ OMADA_CLIENT_SECRET: '${OMADA_CLIENT_SECRET}' }),
            ports: ['127.0.0.1:3017:3000'],
        });
        expect(await core.readState(home, 'docker')).toMatchObject({ current, url: 'http://127.0.0.1:3017/mcp' });
    });
    it('rejects invalid ports, missing credentials and existing project collisions', async () => {
        await expect(cli('setup', 'docker')).rejects.toThrow('--env-file');
        await expect(cli('setup', 'docker', '--project', 'other')).rejects.toThrow('--compose-file');
        for (const port of ['0', '65536', '3.1', 'wrong'])
            await expect(cli('setup', 'docker', '--env-file', envFile, '--port', port)).rejects.toThrow('integer');
        vi.mocked(core.run).mockResolvedValue('existing-container');
        await expect(cli('setup', 'docker', '--env-file', envFile)).rejects.toThrow('already exists');
    });
    it('removes only a newly created service after initial readiness failure', async () => {
        vi.mocked(core.switchDocker).mockRejectedValueOnce(new Error('not ready'));
        await expect(cli('setup', 'docker', '--env-file', envFile)).rejects.toThrow('setup failed verification');
        expect(core.run).toHaveBeenLastCalledWith('docker', expect.arrayContaining(['rm', '--stop', '--force', 'omada-mcp']));
        await expect(core.readState(home, 'docker')).rejects.toThrow('setup docker');
    });
});
