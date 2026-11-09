import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server/common.js';
import { createClientPolicyProxy, ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const scopes = 'devices:r,clients:r,wireless:r,switching:r,network:r,monitoring:r';
describe('combined diagnosis MCP and composed scopes', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((f) => f()));
    });
    async function setup(profile: 'full' | 'read-only' = 'full', categories?: string) {
        const api = {
            diagnoseNetwork: vi.fn().mockResolvedValue({ readOnly: true, collectionComplete: false, observations: [] }),
            getToolAccessPolicy: () => new ToolAccessPolicy(profile, categories),
        };
        const server = createServer(api as never);
        const client = new Client({ name: 'network-contract', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        closers.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([client.connect(ct), server.connect(st)]);
        return { client, api };
    }
    it.each([
        ['full', undefined],
        ['read-only', undefined],
        ['full', scopes],
        ['full', 'all:r'],
    ] as const)('exposes bounded read-only diagnosis in %s/%s', async (profile, categories) => {
        const { client, api } = await setup(profile, categories);
        const tool = (await client.listTools()).tools.find((t) => t.name === 'diagnoseNetwork');
        expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        expect(tool?.inputSchema.additionalProperties).toBe(false);
        expect((await client.callTool({ name: 'diagnoseNetwork', arguments: {} })).isError).toBeFalsy();
        expect(api.diagnoseNetwork).toHaveBeenCalledWith({ hours: 24, maxAps: 10, weakRssiDbm: -75 });
    });
    it.each(['wireless:r', 'all:w', 'all:r,wireless:w', 'devices:r,clients:r,wireless:r,network:r,monitoring:r'])(
        'cannot bypass missing composed read permissions: %s',
        async (categories) => {
            const { client, api } = await setup('full', categories);
            expect((await client.listTools()).tools.some((t) => t.name === 'diagnoseNetwork')).toBe(false);
            expect((await client.callTool({ name: 'diagnoseNetwork', arguments: {} })).isError).toBe(true);
            expect(api.diagnoseNetwork).not.toHaveBeenCalled();
            const proxy = createClientPolicyProxy(api, new ToolAccessPolicy('full', categories));
            await expect(proxy.diagnoseNetwork({})).rejects.toThrow('not permitted');
            expect(api.diagnoseNetwork).not.toHaveBeenCalled();
        }
    );
    it('honors parent-policy intersections for the combined workflow', () => {
        const policy = new ToolAccessPolicy('full', 'all:r').intersect(new ToolAccessPolicy('full', 'wireless:r'));
        expect(policy.allowsTool('diagnoseNetwork')).toBe(false);
    });
    it.each([{ hours: 25 }, { maxAps: 21 }, { weakRssiDbm: -99 }, { unknown: true }, { hours: '24' }])(
        'rejects invalid MCP options before dispatch %j',
        async (args) => {
            const { client, api } = await setup();
            expect((await client.callTool({ name: 'diagnoseNetwork', arguments: args })).isError).toBe(true);
            expect(api.diagnoseNetwork).not.toHaveBeenCalled();
        }
    );
});
