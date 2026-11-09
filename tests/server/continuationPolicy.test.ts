import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import { createServer } from '../../src/server/common.js';
import { createClientPolicyProxy, ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const scope = { version: 1, controllerId: 'controller', siteId: 'site' };
const radio = {
    ...scope,
    resource: 'ap-radio',
    apMac: '02-00-00-00-00-01',
    band: '2g',
    before: { radioSetting2g: { radioEnable: true, channel: '6', freq: 2437, channelWidth: '2', txPowerLevel: 0, wirelessMode: 0 } },
    applied: { radioSetting2g: { radioEnable: true, channel: '11', freq: 2462, channelWidth: '2', txPowerLevel: 0, wirelessMode: 0 } },
};
const dhcp = {
    ...scope,
    resource: 'dhcp-reservation',
    mac: '02-00-00-00-00-02',
    before: null,
    applied: { mac: '02-00-00-00-00-02', netId: 'network', status: false },
    beforeId: null,
    appliedId: 'reservation',
};
const rate = {
    ...scope,
    resource: 'rate-limit-profile',
    profileId: 'profile',
    before: { name: 'Before', upLimitEnable: false, downLimitEnable: false },
    applied: { name: 'After', upLimitEnable: false, downLimitEnable: false },
};
const ssidConfig = {
    name: 'fixture',
    band: 3,
    broadcast: true,
    enable11r: false,
    guestNetEnable: false,
    mloEnable: false,
    pmfMode: 2,
    security: 0,
    vlanEnable: false,
};
const ssid = { ...scope, resource: 'ssid-basic', wlanId: 'wlan', ssidId: 'ssid', before: ssidConfig, applied: { ...ssidConfig, name: 'changed' } };
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
    await Promise.all(close.splice(0).map((fn) => fn()));
});
async function connect(categories: string, readOnly = false) {
    const api = {
        rollbackNetworkChange: vi.fn().mockResolvedValue({ verified: true }),
        refreshApiCatalog: vi.fn().mockResolvedValue({ refreshed: true }),
    };
    const server = createServer(api as unknown as OmadaClient, { toolCategories: categories, toolProfile: readOnly ? 'read-only' : 'full' });
    const client = new Client({ name: 'resource-policy', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    close.push(
        () => client.close(),
        () => server.close()
    );
    await Promise.all([client.connect(a), server.connect(b)]);
    return { api, client };
}

describe('resource-specific rollback authority', () => {
    it.each([
        ['clients:rw', rate, true],
        ['clients:rw', dhcp, false],
        ['clients:rw', radio, false],
        ['network:rw', dhcp, true],
        ['network:rw', radio, false],
        ['network:rw', rate, false],
        ['wireless:rw', radio, true],
        ['wireless:rw', ssid, true],
        ['clients:rw', ssid, false],
        ['network:rw', ssid, false],
        ['wireless:rw', dhcp, false],
        ['wireless:rw', rate, false],
    ] as const)('enforces %s for %s at the MCP handler', async (categories, receipt, allowed) => {
        const { api, client } = await connect(categories);
        const result = await client.callTool({ name: 'rollbackNetworkChange', arguments: { receipt, dryRun: false } });
        expect(!result.isError).toBe(allowed);
        expect(api.rollbackNetworkChange).toHaveBeenCalledTimes(allowed ? 1 : 0);
    });
    it('also enforces resource authority on configured client methods', async () => {
        const api = { rollbackNetworkChange: vi.fn().mockResolvedValue({}) };
        const client = createClientPolicyProxy(api, new ToolAccessPolicy('full', 'clients:rw'));
        await expect(client.rollbackNetworkChange(dhcp)).rejects.toThrow('Rollback resource');
        expect(api.rollbackNetworkChange).not.toHaveBeenCalled();
        await client.rollbackNetworkChange(rate);
        expect(api.rollbackNetworkChange).toHaveBeenCalledExactlyOnceWith(rate);
    });
    it('cannot combine disjoint parent permissions into broader rollback authority', () => {
        const policy = new ToolAccessPolicy('full', 'network:rw').intersect(new ToolAccessPolicy('full', 'wireless:rw'));
        expect(policy.allowsTool('rollbackNetworkChange', true)).toBe(false);
        expect(() => policy.assertTool('rollbackNetworkChange', { receipt: radio })).toThrow();
    });
    it('keeps refresh callable in global read-only mode while hiding rollback', async () => {
        const { api, client } = await connect('all:rw', true);
        const { tools } = await client.listTools();
        expect(tools.some((tool) => tool.name === 'rollbackNetworkChange')).toBe(false);
        expect(tools.find((tool) => tool.name === 'refreshApiCatalog')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect((await client.callTool({ name: 'refreshApiCatalog', arguments: {} })).isError).toBeFalsy();
        expect(api.refreshApiCatalog).toHaveBeenCalledOnce();
        expect((await client.callTool({ name: 'refreshApiCatalog', arguments: { url: 'https://external.test/spec' } })).isError).toBe(true);
        expect(api.refreshApiCatalog).toHaveBeenCalledOnce();
    });
});
