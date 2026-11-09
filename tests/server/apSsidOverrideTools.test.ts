import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server/common.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';

describe('AP SSID override MCP contracts and policy', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((close) => close()));
    });
    async function setup(toolProfile: 'full' | 'read-only' = 'full', toolCategories?: string) {
        const api = {
            getApSsidOverrides: vi.fn().mockResolvedValue({ ssidOverrides: [] }),
            updateApSsidOverride: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
            getToolAccessPolicy: () => new ToolAccessPolicy(toolProfile, toolCategories),
        };
        const server = createServer(api as never);
        const client = new Client({ name: 'override-test', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        closers.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(st), client.connect(ct)]);
        return { api, client };
    }
    const apMac = 'AA-BB-CC-DD-EE-FF';
    it('exposes strict schemas and defaults updates to previews', async () => {
        const { api, client } = await setup();
        const result = await client.callTool({ name: 'updateApSsidOverride', arguments: { apMac, ssidEntryId: 1, settings: { ssidEnable: false } } });
        expect(result.isError).toBeFalsy();
        expect(api.updateApSsidOverride).toHaveBeenCalledWith(apMac, 1, { ssidEnable: false }, undefined, true);
        const { tools } = await client.listTools();
        expect(tools.find((t) => t.name === 'getApSsidOverrides')?.annotations?.readOnlyHint).toBe(true);
        expect(tools.find((t) => t.name === 'updateApSsidOverride')?.inputSchema.additionalProperties).toBe(false);
    });
    it('dispatches explicit apply and read arguments', async () => {
        const { api, client } = await setup();
        await client.callTool({ name: 'getApSsidOverrides', arguments: { apMac, siteId: 'site' } });
        await client.callTool({
            name: 'updateApSsidOverride',
            arguments: { apMac, siteId: 'site', ssidEntryId: 3, settings: { ssidEnable: false }, dryRun: false },
        });
        expect(api.getApSsidOverrides).toHaveBeenCalledWith(apMac, 'site');
        expect(api.updateApSsidOverride).toHaveBeenCalledWith(apMac, 3, { ssidEnable: false }, 'site', false);
    });
    it.each([{}, { ssidEnable: 'no' }, { unknown: true }])('rejects invalid settings %j before dispatch', async (settings) => {
        const { api, client } = await setup();
        expect((await client.callTool({ name: 'updateApSsidOverride', arguments: { apMac, ssidEntryId: 1, settings } })).isError).toBe(true);
        expect(api.updateApSsidOverride).not.toHaveBeenCalled();
    });
    it.each([
        ['read-only', undefined],
        ['full', 'wireless:r'],
        ['full', 'all:rw,wireless:r'],
    ] as const)('blocks writes and previews for %s / %s', async (profile, categories) => {
        const { api, client } = await setup(profile, categories);
        const { tools } = await client.listTools();
        expect(tools.some((t) => t.name === 'getApSsidOverrides')).toBe(true);
        expect(tools.some((t) => t.name === 'updateApSsidOverride')).toBe(false);
        expect(
            (
                await client.callTool({
                    name: 'updateApSsidOverride',
                    arguments: { apMac, ssidEntryId: 1, settings: { ssidEnable: false }, dryRun: false },
                })
            ).isError
        ).toBe(true);
        expect(api.updateApSsidOverride).not.toHaveBeenCalled();
    });
    it('does not expose override tools under other categories', async () => {
        const { client } = await setup('full', 'devices:rw');
        const { tools } = await client.listTools();
        expect(tools.some((t) => /ApSsidOverride/.test(t.name))).toBe(false);
    });
});
