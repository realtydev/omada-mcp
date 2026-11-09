import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshClient } from '../../src/runtime/clientRefresh.js';
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
