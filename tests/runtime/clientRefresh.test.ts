import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshClient, reloadCodex } from '../../src/runtime/clientRefresh.js';
import type { ClientRegistration } from '../../src/runtime/clients.js';

const registration = (client: ClientRegistration['client'], restartOnUpdate = false): ClientRegistration => ({
    client,
    restartOnUpdate,
    configPath: '/tmp/test/config.json',
});
const nativePlatform = process.platform;
afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: nativePlatform });
});

describe('Codex supported reload', () => {
    it('initializes the existing proxy connection and waits for the reload acknowledgment', async () => {
        const source = `const readline = require('node:readline').createInterface({input: process.stdin}); let initialized = false; readline.on('line', line => {const request=JSON.parse(line); if(request.method==='initialize') process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n'); else if(request.method==='initialized') initialized=true; else if(request.method==='config/mcpServer/reload' && initialized) process.stdout.write(JSON.stringify({id:request.id,result:{}})+'\\n'); else process.exit(2);});`;
        const createProxy = () => spawn(process.execPath, ['-e', source], { stdio: 'pipe' });
        expect(await reloadCodex(createProxy, 2_000)).toBe(true);
    });
    it('reports unavailable, malformed and rejected reloads without claiming reconnection', async () => {
        expect(await reloadCodex(() => spawn('/no/such/codex', [], { stdio: 'pipe' }), 1000)).toBe(false);
        expect(await reloadCodex(() => spawn(process.execPath, ['-e', 'process.stdout.write("not-json\\n")'], { stdio: 'pipe' }), 1000)).toBe(false);
        expect(
            await reloadCodex(
                () =>
                    spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({id:1,error:{message:"denied"}})+"\\n")'], { stdio: 'pipe' }),
                1000
            )
        ).toBe(false);
    });
    it('bounds an unresponsive proxy without stopping an app server', async () => {
        const proxy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'pipe' });
        const kill = vi.spyOn(proxy, 'kill');
        expect(await reloadCodex(() => proxy, 25)).toBe(false);
        expect(kill).toHaveBeenCalledWith('SIGTERM');
    });
    it('distinguishes a queued reload from a verified client connection', async () => {
        const result = await refreshClient(registration('codex'), vi.fn(), async () => true);
        expect(result.status).toBe('reload-queued');
        expect(result.message).toContain('verify getServerInfo');
        expect((await refreshClient(registration('codex', true), vi.fn(), async () => false)).status).toBe('action-required');
    });
});

describe('explicit desktop restart', () => {
    it('never restarts a desktop client without opt-in', async () => {
        const execute = vi.fn();
        expect((await refreshClient(registration('cursor'), execute)).status).toBe('action-required');
        expect((await refreshClient(registration('claude-desktop'), execute)).status).toBe('action-required');
        expect(execute).not.toHaveBeenCalled();
    });
    it('does not launch a desktop client that was already closed', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const execute = vi.fn(async () => 'not-running');
        expect((await refreshClient(registration('cursor', true), execute)).status).toBe('not-running');
        expect(execute).toHaveBeenCalledTimes(1);
    });
    it('uses graceful quit and relaunch with fixed app identifiers, without force-killing', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const execute = vi.fn().mockResolvedValueOnce('quit').mockResolvedValueOnce('');
        expect((await refreshClient(registration('claude-desktop', true), execute)).status).toBe('restart-requested');
        expect(execute.mock.calls[0][1][1]).toContain('tell application id "com.anthropic.claudefordesktop" to quit');
        expect(execute.mock.calls[1]).toEqual(['open', ['-b', 'com.anthropic.claudefordesktop']]);
    });
    it('reports unsupported platforms without starting desktop commands', async () => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const execute = vi.fn();
        expect((await refreshClient(registration('cursor', true), execute)).status).toBe('action-required');
        expect(execute).not.toHaveBeenCalled();
    });
    it('does not claim a successful restart after a rejected or unconfirmed quit', async () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });
        const execute = vi.fn(async () => 'still-running');
        expect((await refreshClient(registration('cursor', true), execute)).status).toBe('action-required');
        expect(execute).not.toHaveBeenCalledWith('open', expect.anything());
    });
});
