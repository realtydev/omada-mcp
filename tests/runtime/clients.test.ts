import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshClient } from '../../src/runtime/clientRefresh.js';
import { clientEntry, configureClient, refreshClients, validateClientMode } from '../../src/runtime/clients.js';
import { type RuntimeState, readState } from '../../src/runtime/core.js';

vi.mock('../../src/runtime/clientRefresh.js', () => ({ refreshClient: vi.fn() }));
let home: string;
let path: string;
const docker = (): RuntimeState => ({
    mode: 'docker',
    current: { version: '0.8.0', image: 'example@sha256:test' },
    composeFile: '/tmp/compose.yaml',
    project: 'test',
    service: 'mcp',
    url: 'http://127.0.0.1:3000/mcp',
});
const stdio = (): RuntimeState => ({
    mode: 'stdio',
    current: { version: '0.8.0', entry: '/tmp/version/dist/index.js' },
    envFile: '/tmp/private.env',
});
beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'omada-client-test-')));
    path = join(home, 'client.json');
    vi.mocked(refreshClient).mockResolvedValue({ client: 'cursor', status: 'action-required', message: 'Reconnect in client.' });
});
afterEach(async () => {
    vi.clearAllMocks();
    await rm(home, { recursive: true, force: true });
});

describe('client configuration', () => {
    it('uses native configuration fields while preserving the pinned local stdio launcher', async () => {
        const entry = await clientEntry(home, stdio(), 'claude-desktop');
        expect(entry.command).toBe(process.execPath);
        expect(entry.args).toEqual([join(home, 'stdio.mjs')]);
        expect(JSON.stringify(entry)).not.toContain('private.env');
        expect(() => validateClientMode('claude-desktop', 'docker')).toThrow('requires stdio');
        expect(() => validateClientMode('codex', 'docker')).not.toThrow();
        expect(() => validateClientMode('cursor', 'docker')).not.toThrow();
    });
    it('adds only Omada while retaining comments, trailing commas and unrelated settings', async () => {
        const original =
            '{\n  // keep this comment\n  "theme": "dark",\n  "mcpServers": {"other": {"command": "node", "env": {"TOKEN": "test-secret"}},},\n}\n';
        await writeFile(path, original);
        const state = docker();
        const result = await configureClient(home, state, 'cursor', { configPath: path });
        const output = await readFile(path, 'utf8');
        expect(output).toContain('// keep this comment');
        expect(output).toContain('"theme": "dark"');
        expect(output).toContain('"TOKEN": "test-secret"');
        expect(output).toContain('http://127.0.0.1:3000/mcp');
        expect(await readFile(result.backupPath ?? '', 'utf8')).toBe(original);
        expect((await stat(result.backupPath ?? '')).mode & 0o777).toBe(0o600);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await readState(home, 'docker')).toMatchObject({ clients: [{ client: 'cursor', configPath: path, restartOnUpdate: false }] });
    });
    it('is idempotent and preserves extra options on a matching existing entry', async () => {
        const original = '{"mcpServers":{"omada":{"url":"http://127.0.0.1:3000/mcp","headers":{"Authorization":"test-secret"},"disabled":true}}}';
        await writeFile(path, original);
        const result = await configureClient(home, docker(), 'cursor', { configPath: path });
        expect(result.changed).toBe(false);
        expect(result.backupPath).toBeUndefined();
        expect(result.refresh.message).toContain('disabled');
        expect(refreshClient).not.toHaveBeenCalled();
        expect(await readFile(path, 'utf8')).toBe(original);
    });
    it('refuses conflicting server names and requires explicit replacement with a backup', async () => {
        const original = '{"mcpServers":{"omada":{"url":"http://127.0.0.1:3999/mcp"},"other":{"command":"other"}}}';
        await writeFile(path, original);
        await expect(configureClient(home, docker(), 'cursor', { configPath: path })).rejects.toThrow('--replace-client');
        expect(await readFile(path, 'utf8')).toBe(original);
        const result = await configureClient(home, docker(), 'cursor', { configPath: path, replace: true, restart: true });
        expect(await readFile(result.backupPath ?? '', 'utf8')).toBe(original);
        expect((await readState(home, 'docker')).clients?.[0].restartOnUpdate).toBe(true);
        expect(refreshClient).toHaveBeenLastCalledWith(expect.objectContaining({ restartOnUpdate: true }), expect.any(Function));
    });
    it('rejects invalid, duplicated and incompatible config structures without writing', async () => {
        for (const original of [
            'broken JSON',
            '[]',
            '{"mcpServers":[]}',
            '{"mcpServers":{},"mcpServers":{}}',
            '{"mcpServers":{"other":{"x":1,"x":2}}}',
        ]) {
            await writeFile(path, original);
            await expect(configureClient(home, docker(), 'cursor', { configPath: path })).rejects.toThrow();
            expect(await readFile(path, 'utf8')).toBe(original);
        }
    });
    it('does not accept a different explicit transport type as a matching entry', async () => {
        const original = '{"mcpServers":{"omada":{"type":"sse","url":"http://127.0.0.1:3000/mcp"}}}';
        await writeFile(path, original);
        await expect(configureClient(home, docker(), 'cursor', { configPath: path })).rejects.toThrow('--replace-client');
    });
    it('preserves JSON configuration symlinks and edits the real target', async () => {
        const target = join(home, 'actual.json');
        await writeFile(target, '{}\n');
        await symlink(target, path);
        await configureClient(home, docker(), 'cursor', { configPath: path });
        expect(await readFile(target, 'utf8')).toContain('omada');
        expect(await realLink(path)).toBe(target);
    });
    it('adds Claude Desktop only in stdio and keeps credentials outside the client file', async () => {
        const result = await configureClient(home, stdio(), 'claude-desktop', { configPath: path });
        expect(result.changed).toBe(true);
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        expect(parsed.mcpServers.omada.args).toEqual([join(home, 'stdio.mjs')]);
        expect(parsed.mcpServers.omada.env).toBeUndefined();
        await expect(configureClient(home, docker(), 'claude-desktop', { configPath: path })).rejects.toThrow('requires stdio');
    });
    it('uses the native Codex CLI with the selected profile and verifies its saved entry', async () => {
        path = join(home, 'config.toml');
        const original = '# retain comment\nmodel = "example"\n';
        await writeFile(path, original);
        let entries: unknown[] = [];
        const execute = vi.fn((_command, args, _cwd, environment) => {
            expect(environment).toEqual({ CODEX_HOME: home });
            if (args.includes('list')) return Promise.resolve(JSON.stringify(entries));
            expect(args).toEqual(['mcp', 'add', 'omada', '--url', 'http://127.0.0.1:3000/mcp']);
            entries = [{ name: 'omada', transport: { type: 'streamable_http', url: 'http://127.0.0.1:3000/mcp' } }];
            return Promise.resolve('added');
        });
        const result = await configureClient(home, docker(), 'codex', { configPath: path }, execute);
        expect(result.changed).toBe(true);
        expect(execute).toHaveBeenCalledTimes(3);
        expect(await readFile(result.backupPath ?? '', 'utf8')).toBe(original);
        const repeat = await configureClient(home, docker(), 'codex', { configPath: path }, execute);
        expect(repeat.changed).toBe(false);
    });
    it('does not overwrite settings if the native client rejects or ignores registration', async () => {
        const original = 'original = true\n';
        path = join(home, 'config.toml');
        await writeFile(path, original);
        await expect(configureClient(home, docker(), 'codex', { configPath: path }, async () => '[]')).rejects.toThrow('did not save');
        expect(await readFile(path, 'utf8')).toBe(original);
        await expect(
            configureClient(home, docker(), 'codex', { configPath: path }, () => Promise.reject(new Error('invalid configuration')))
        ).rejects.toThrow('invalid configuration');
        expect(await readFile(path, 'utf8')).toBe(original);
    });
    it('refuses Codex configuration symlinks before calling its writer', async () => {
        const target = join(home, 'actual.toml');
        await writeFile(target, '# keep\n');
        await symlink(target, path);
        const execute = vi.fn(async () => '[]');
        await expect(configureClient(home, docker(), 'codex', { configPath: path }, execute)).rejects.toThrow('symlink');
        expect(execute).not.toHaveBeenCalled();
    });
    it('preserves all registered clients in the same runtime state', async () => {
        const state = stdio();
        await configureClient(home, state, 'cursor', { configPath: path });
        await configureClient(home, state, 'claude-desktop', { configPath: join(home, 'claude.json') });
        expect((await readState(home, 'stdio')).clients?.map((item) => item.client)).toEqual(['cursor', 'claude-desktop']);
    });
});

async function realLink(path: string): Promise<string> {
    return (await import('node:fs/promises')).readlink(path);
}

describe('registered client refresh', () => {
    it('refreshes only a matching saved registration after an update', async () => {
        const state = docker();
        await configureClient(home, state, 'cursor', { configPath: path });
        vi.mocked(refreshClient).mockClear();
        const results = await refreshClients(home, state, true);
        expect(results).toHaveLength(1);
        expect(refreshClient).toHaveBeenCalledWith(expect.objectContaining({ restartOnUpdate: true }), expect.any(Function));
    });
    it('does not restart a client whose config was changed outside the runtime', async () => {
        const state = docker();
        await configureClient(home, state, 'cursor', { configPath: path });
        await writeFile(path, '{"mcpServers":{"omada":{"url":"http://127.0.0.1:3999/mcp"}}}');
        vi.mocked(refreshClient).mockClear();
        expect(await refreshClients(home, state, true)).toEqual([
            expect.objectContaining({ status: 'action-required', message: expect.stringContaining('changed outside') }),
        ]);
        expect(refreshClient).not.toHaveBeenCalled();
    });
    it('reports missing or corrupt client files without failing the runtime update', async () => {
        const state = docker();
        await configureClient(home, state, 'cursor', { configPath: path });
        await rm(path);
        expect(await refreshClients(home, state)).toEqual([expect.objectContaining({ status: 'action-required' })]);
        expect(await refreshClients(home, docker())).toEqual([]);
    });
});
