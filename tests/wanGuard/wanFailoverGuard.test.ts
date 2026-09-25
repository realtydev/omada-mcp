import { describe, expect, it, vi } from 'vitest';

import { isIpv4InCidr, WanFailoverGuard, type WanGuardClient } from '../../src/wanGuard/wanFailoverGuard.js';

function createClient(statuses: Array<Record<string, unknown>>): WanGuardClient {
    return {
        getGatewayWanStatus: vi.fn().mockResolvedValue(statuses),
        setGatewayWanConnect: vi.fn().mockResolvedValue({}),
    } as unknown as WanGuardClient;
}

function createGuard(client: WanGuardClient, dryRun = false): WanFailoverGuard {
    return new WanFailoverGuard(client, {
        gatewayMac: 'AA-BB-CC-DD-EE-FF',
        siteId: 'site-1',
        primaryPort: 2,
        fallbackCidrs: ['192.168.100.0/24'],
        failureThreshold: 2,
        dryRun,
    });
}

describe('WAN failover guard', () => {
    it('matches only IPv4 addresses inside the configured CIDR', () => {
        expect(isIpv4InCidr('192.168.100.10', '192.168.100.0/24')).toBe(true);
        expect(isIpv4InCidr('192.168.101.10', '192.168.100.0/24')).toBe(false);
        expect(isIpv4InCidr('203.0.113.20', '192.168.100.0/24')).toBe(false);
        expect(isIpv4InCidr('invalid', '192.168.100.0/24')).toBe(false);
    });

    it('never disconnects a public primary WAN address', async () => {
        const client = createClient([{ port: 2, status: 1, ip: '203.0.113.20' }]);
        const result = await createGuard(client).checkOnce();

        expect(result).toEqual({ action: 'healthy', ip: '203.0.113.20', consecutiveFallbacks: 0 });
        expect(client.setGatewayWanConnect).not.toHaveBeenCalled();
    });

    it('requires consecutive fallback observations before disconnecting', async () => {
        const client = createClient([{ port: 2, status: 1, ip: '192.168.100.10' }]);
        const guard = createGuard(client);

        await expect(guard.checkOnce()).resolves.toEqual({ action: 'observed_fallback', ip: '192.168.100.10', consecutiveFallbacks: 1 });
        await expect(guard.checkOnce()).resolves.toEqual({ action: 'disconnected', ip: '192.168.100.10', consecutiveFallbacks: 0 });
        expect(client.setGatewayWanConnect).toHaveBeenCalledWith('AA-BB-CC-DD-EE-FF', 2, 'disconnect', 'site-1');
    });

    it('resets the fallback counter after a public address appears', async () => {
        const client = createClient([{ port: 2, status: 1, ip: '192.168.100.10' }]);
        const guard = createGuard(client);

        await guard.checkOnce();
        (client.getGatewayWanStatus as ReturnType<typeof vi.fn>).mockResolvedValue([{ port: 2, status: 1, ip: '203.0.113.20' }]);
        await guard.checkOnce();
        (client.getGatewayWanStatus as ReturnType<typeof vi.fn>).mockResolvedValue([{ port: 2, status: 1, ip: '192.168.100.10' }]);

        await expect(guard.checkOnce()).resolves.toEqual({ action: 'observed_fallback', ip: '192.168.100.10', consecutiveFallbacks: 1 });
        expect(client.setGatewayWanConnect).not.toHaveBeenCalled();
    });

    it('reports the intended action without mutating in dry-run mode', async () => {
        const client = createClient([{ port: 2, status: 1, ip: '192.168.100.10' }]);
        const guard = createGuard(client, true);

        await guard.checkOnce();
        await expect(guard.checkOnce()).resolves.toEqual({ action: 'would_disconnect', ip: '192.168.100.10', consecutiveFallbacks: 2 });
        expect(client.setGatewayWanConnect).not.toHaveBeenCalled();
    });

    it('does not repeat a disconnect when the port is already disconnected', async () => {
        const client = createClient([{ port: 2, status: 0, ip: '192.168.100.10' }]);
        const result = await createGuard(client).checkOnce();

        expect(result.action).toBe('already_disconnected');
        expect(client.setGatewayWanConnect).not.toHaveBeenCalled();
    });
});
