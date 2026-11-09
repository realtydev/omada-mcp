import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server/common.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';

describe('switch port coverage MCP contract', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((close) => close()));
    });
    async function setup(profile: 'full' | 'read-only' = 'full', categories?: string) {
        const api = {
            getSwitchPortOverview: vi.fn().mockResolvedValue({ collectionComplete: false, ports: [], switches: [{ status: 'unavailable' }] }),
            listSwitchPorts: vi.fn().mockResolvedValue([{ port: 1 }]),
            getToolAccessPolicy: () => new ToolAccessPolicy(profile, categories),
        };
        const server = createServer(api as never);
        const client = new Client({ name: 'port-coverage', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        closers.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([client.connect(ct), server.connect(st)]);
        return { api, client };
    }
    it.each([
        ['full', undefined],
        ['read-only', undefined],
        ['full', 'switching:r'],
    ] as const)('exposes read coverage in %s/%s', async (profile, categories) => {
        const { api, client } = await setup(profile, categories);
        const result = await client.callTool({ name: 'getSwitchPortOverview', arguments: { switchMac: 'AA-BB-CC-DD-EE-FF', siteId: 'site' } });
        expect(result.isError).toBeFalsy();
        expect(api.getSwitchPortOverview).toHaveBeenCalledWith('AA-BB-CC-DD-EE-FF', 'site');
        expect((await client.listTools()).tools.find((t) => t.name === 'getSwitchPortOverview')?.annotations).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
        });
    });
    it('retains listSwitchPorts array output', async () => {
        const { client } = await setup();
        const r = await client.callTool({ name: 'listSwitchPorts', arguments: {} });
        expect(JSON.parse((r.content as Array<{ text: string }>)[0].text)).toEqual([{ port: 1 }]);
    });
    it('hides and denies the tool outside switching scope', async () => {
        const { api, client } = await setup('full', 'wireless:r');
        expect((await client.listTools()).tools.some((t) => t.name === 'getSwitchPortOverview')).toBe(false);
        expect((await client.callTool({ name: 'getSwitchPortOverview', arguments: {} })).isError).toBe(true);
        expect(api.getSwitchPortOverview).not.toHaveBeenCalled();
    });
    it('rejects unknown MCP arguments before dispatch', async () => {
        const { api, client } = await setup();
        expect((await client.callTool({ name: 'getSwitchPortOverview', arguments: { unknown: true } })).isError).toBe(true);
        expect(api.getSwitchPortOverview).not.toHaveBeenCalled();
    });
});
