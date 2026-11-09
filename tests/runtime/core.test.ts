import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    verifyBuild,
    verifyDockerSelection,
    version,
    withLock,
    writeLauncher,
} from '../../src/runtime/core.js';

let home: string;
const current = { version: '0.7.0', image: `${IMAGE}@sha256:old` };
const candidate = { version: '0.8.0', gitCommit: 'a'.repeat(40), image: `${IMAGE}@sha256:new` };
const info = { packageVersion: '0.8.0', gitCommit: 'abc123', buildTime: '2026-11-08T00:00:00Z' };
const docker = (): RuntimeState => ({
    mode: 'docker',
    current,
    composeFile: '/tmp/service/compose.yaml',
    project: 'existing',
    service: 'omada-mcp',
    url: 'http://127.0.0.1:3000/mcp',
});
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'omada-runtime-test-'));
});
afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(home, { recursive: true, force: true });
});

describe('runtime boundaries', () => {
    it('rejects moving tags, shell input and paths while accepting exact release versions', () => {
        for (const input of ['latest', 'v0.8.0', '../other', '0.8', '^0.8.0', '01.2.3', '0.8.0;echo bad'])
            expect(() => version(input)).toThrow('exact version');
        expect(version('0.8.0-rc.1')).toBe('0.8.0-rc.1');
    });
    it('resolves latest once and rejects failed or malformed releases', async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tag_name: 'v0.8.0' }) });
        vi.stubGlobal('fetch', fetcher);
        expect(await releaseVersion('latest')).toBe('0.8.0');
        expect(await releaseVersion('0.7.0')).toBe('0.7.0');
        expect(fetcher).toHaveBeenCalledTimes(1);
        fetcher.mockResolvedValueOnce({ ok: false });
        await expect(releaseVersion('latest')).rejects.toThrow('Cannot resolve');
        fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
        await expect(releaseVersion('latest')).rejects.toThrow('exact version');
    });
    it('rejects a same-version stale commit and invalid build identities', () => {
        const expected = { ...candidate, gitCommit: 'abcdef0123456789abcdef0123456789abcdef0123' };
        const valid = { ...info, gitCommit: 'abcdef0' };
        expect(() => verifyBuild(valid, expected)).not.toThrow();
        expect(() => verifyBuild({ ...valid, gitCommit: '7654321' }, expected)).toThrow('identity');
        expect(() => verifyBuild({ ...valid, gitCommit: '' }, expected)).toThrow('identity');
        expect(() => verifyBuild({ ...valid, buildTime: 'invalid' }, expected)).toThrow('identity');
        expect(() => verifyBuild({ ...valid, packageVersion: '0.7.0' }, expected)).toThrow('identity');
    });
    it('accepts loopback HTTP only', () => {
        expect(localUrl('http://127.0.0.1:3000/mcp')).toContain('/mcp');
        expect(localUrl('http://[::1]:3000/mcp')).toContain('[::1]');
        for (const url of [
            'https://localhost/mcp',
            'http://192.0.2.1/mcp',
            'http://user:pass@localhost/mcp',
            'http://localhost/mcp?token=x',
            'http://localhost/mcp#x',
        ])
            expect(() => localUrl(url)).toThrow('local HTTP');
    });
    it('writes private state atomically and validates state mode', async () => {
        await expect(readState(home, 'docker')).rejects.toThrow('setup docker');
        await atomicJson(statePath(home, 'docker'), docker());
        expect(await readState(home, 'docker')).toEqual(docker());
        expect((await stat(statePath(home, 'docker'))).mode & 0o777).toBe(0o600);
        await atomicJson(statePath(home, 'stdio'), docker());
        await expect(readState(home, 'stdio')).rejects.toThrow('setup stdio');
    });
    it('locks mutations across modes and releases after errors', async () => {
        await expect(
            withLock(home, async () => {
                await expect(withLock(home, async () => undefined)).rejects.toThrow('in progress');
                throw new Error('failure');
            })
        ).rejects.toThrow('failure');
        await expect(withLock(home, async () => 'done')).resolves.toBe('done');
    });
    it('reads dotenv without modifying it or printing secrets', async () => {
        const file = join(home, '.env');
        const content = 'OMADA_CLIENT_SECRET="test$secret"\n';
        await writeFile(file, content);
        expect(await readEnv(file)).toEqual({ OMADA_CLIENT_SECRET: 'test$secret' });
        expect(await readFile(file, 'utf8')).toBe(content);
        await expect(readEnv(join(home, 'missing'))).rejects.toThrow('Cannot read');
    });
    it('captures successful commands and suppresses private subprocess errors', async () => {
        expect(await run(process.execPath, ['-e', 'process.stdout.write("ok")'])).toBe('ok');
        await expect(run(process.execPath, ['-e', 'process.stderr.write("test-password"); process.exit(9)'])).rejects.toThrow('exit 9');
        await expect(run('/no/such/omada-command', [])).rejects.toThrow('Cannot run');
    });
    it('creates a standalone launcher with a private mode and no embedded credentials', async () => {
        const path = await writeLauncher(home);
        const text = await readFile(path, 'utf8');
        expect(text).toContain('#!/usr/bin/env node');
        expect(text).toContain('MCP_SERVER_USE_HTTP');
        expect(text).not.toContain('OMADA_CLIENT_SECRET');
        expect((await stat(path)).mode & 0o777).toBe(0o700);
    });
    it('fails closed on an unavailable runtime without leaking endpoint errors', async () => {
        await expect(probe({ ...docker(), url: 'http://127.0.0.1:1/mcp' })).rejects.toThrow('Cannot verify 0.7.0');
    });
});

describe('versioned stdio installation', () => {
    const metadata = async (target = '0.8.0') => {
        const folder = join(home, 'versions/0.8.0/node_modules/@realtydev/omada-mcp');
        await mkdir(join(folder, 'dist/generated'), { recursive: true });
        await writeFile(join(folder, 'package.json'), JSON.stringify({ version: target, type: 'module' }));
        await writeFile(join(folder, 'dist/index.js'), '');
        await writeFile(
            join(folder, 'dist/generated/buildInfo.js'),
            `export const PACKAGE_VERSION = ${JSON.stringify(target)};\nexport const GIT_COMMIT = "abc1234";\n`
        );
    };
    it('installs a release archive with scripts disabled and reuses the pinned install', async () => {
        const execute = vi.fn(async () => {
            await metadata();
            return '';
        });
        const selection = await installStdio(home, '0.8.0', undefined, execute);
        expect(selection.entry).toContain('/versions/0.8.0/node_modules/@realtydev/omada-mcp/dist/index.js');
        expect(execute.mock.calls[0]).toEqual([
            'npm',
            expect.arrayContaining(['--ignore-scripts', '--omit=dev', expect.stringContaining('/v0.8.0/realtydev-omada-mcp-0.8.0.tgz')]),
        ]);
        expect(await installStdio(home, '0.8.0', undefined, execute)).toEqual(selection);
        expect(execute).toHaveBeenCalledTimes(1);
    });
    it('removes failed installs and rejects mismatched archive versions', async () => {
        await expect(
            installStdio(home, '0.8.0', '/tmp/offline.tgz', async () => {
                await metadata('0.7.0');
                return '';
            })
        ).rejects.toThrow('does not match');
        await expect(stat(join(home, 'versions/0.8.0'))).rejects.toThrow();
        await expect(installStdio(home, '0.8.0', undefined, () => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
        await expect(stat(join(home, 'versions/0.8.0'))).rejects.toThrow();
    });
});

describe('Docker pinning and recovery', () => {
    it('pins pulled images to immutable registry digests', async () => {
        const execute = vi.fn(async (_command: string, args: string[]) =>
            args[0] === 'pull'
                ? ''
                : JSON.stringify({ RepoDigests: [candidate.image], Config: { Labels: { 'org.opencontainers.image.revision': candidate.gitCommit } } })
        );
        expect(await pullImage('0.8.0', execute)).toEqual(candidate);
        expect(execute.mock.calls[0]).toEqual(['docker', ['pull', `${IMAGE}:0.8.0`]]);
    });
    it('uses a temporary anonymous config on pull failure without changing global credentials', async () => {
        let configPath = '';
        const execute = vi.fn((_command: string, args: string[]) => {
            if (args[0] === 'pull') return Promise.reject(new Error('denied'));
            if (args[0] === 'context') return Promise.resolve('unix:///tmp/docker.sock');
            if (args.includes('--config')) {
                configPath = args[3];
                expect(args).toContain('pull');
                return Promise.resolve('');
            }
            return Promise.resolve(
                JSON.stringify({ RepoDigests: [candidate.image], Config: { Labels: { 'org.opencontainers.image.revision': candidate.gitCommit } } })
            );
        });
        expect(await pullImage('0.8.0', execute)).toEqual(candidate);
        expect(configPath).toContain('omada-docker-');
        await expect(stat(configPath)).rejects.toThrow();
    });
    it('rejects stopped or externally changed containers before updates', async () => {
        const execute = vi.fn().mockResolvedValueOnce('container-id').mockResolvedValueOnce('sha256:expected').mockResolvedValueOnce('sha256:actual');
        await expect(verifyDockerSelection(home, docker(), execute)).rejects.toThrow('changed outside');
        await expect(verifyDockerSelection(home, docker(), async () => '')).rejects.toThrow('one running');
        const matching = vi.fn().mockResolvedValueOnce('container-id').mockResolvedValue('sha256:expected');
        await expect(verifyDockerSelection(home, docker(), matching)).resolves.toBeUndefined();
    });
    it('passes parsed credential values in memory when starting a generated service', async () => {
        const envFile = join(home, 'private.env');
        await writeFile(envFile, 'OMADA_CLIENT_SECRET="test$secret"\n');
        const execute = vi.fn(async () => '');
        await switchDocker(home, { ...docker(), envFile }, candidate, execute, async () => info);
        expect(execute).toHaveBeenCalledWith('docker', expect.arrayContaining(['up']), undefined, { OMADA_CLIENT_SECRET: 'test$secret' });
        expect(await readFile(join(home, 'docker-override.json'), 'utf8')).not.toContain('secret');
        expect(
            await run(process.execPath, ['-e', 'process.stdout.write(process.env.OMADA_TEST_VALUE)'], undefined, { OMADA_TEST_VALUE: 'test$value' })
        ).toBe('test$value');
    });
    it('does not change the service when the pull has no registry digest', async () => {
        await expect(pullImage('0.8.0', async (_command, args) => (args[0] === 'pull' ? '' : '{}'))).rejects.toThrow('no registry digest');
    });
    it('changes only the selected Compose service and saves history after readiness', async () => {
        const execute = vi.fn(async () => '');
        const verify = vi.fn(async () => info);
        expect(await switchDocker(home, docker(), candidate, execute, verify)).toEqual(info);
        expect(execute.mock.calls[0]).toEqual(['docker', [...composeArgs(home, docker()), 'up', '-d', '--no-deps', '--pull', 'never', 'omada-mcp']]);
        expect(await readState(home, 'docker')).toMatchObject({ current: candidate, previous: current });
        expect(JSON.parse(await readFile(join(home, 'docker-override.json'), 'utf8'))).toEqual({
            services: { 'omada-mcp': { image: candidate.image } },
        });
    });
    it('restores and verifies the previous image after Compose fails; history stays intact', async () => {
        const state = docker();
        await atomicJson(statePath(home, 'docker'), state);
        const execute = vi.fn().mockRejectedValueOnce(new Error('bad candidate')).mockResolvedValue('');
        const verify = vi.fn(async () => ({ ...info, packageVersion: '0.7.0' }));
        await expect(switchDocker(home, state, candidate, execute, verify)).rejects.toThrow('previous image was restored and verified');
        expect(verify).toHaveBeenCalledWith(state, current);
        expect(await readState(home, 'docker')).toEqual(state);
        expect(JSON.parse(await readFile(join(home, 'docker-override.json'), 'utf8')).services['omada-mcp'].image).toBe(current.image);
    });
    it('reports recovery failures clearly without claiming success', async () => {
        await expect(switchDocker(home, docker(), candidate, () => Promise.reject(new Error('daemon unavailable')))).rejects.toThrow(
            'recovery could not be verified'
        );
    });
    it('retries readiness and restores the old image after mismatched builds', async () => {
        const execute = vi.fn(async () => '');
        const verify = vi.fn((_state, selection) =>
            selection?.version === '0.8.0' ? Promise.reject(new Error('wrong build')) : Promise.resolve({ ...info, packageVersion: '0.7.0' })
        );
        await expect(switchDocker(home, docker(), candidate, execute, verify)).rejects.toThrow('previous image was restored and verified');
        expect(verify).toHaveBeenCalledTimes(11);
    }, 15_000);
});
