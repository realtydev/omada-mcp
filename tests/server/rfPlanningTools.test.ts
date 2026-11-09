import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server/common.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';

describe('RF planning MCP contract and access policy', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((f) => f()));
    });
    async function setup(profile: 'full' | 'read-only' = 'full', categories?: string) {
        const api = {
            getRfPlanningStatus: vi.fn().mockResolvedValue({ readOnly: true, collectionComplete: true }),
            getToolAccessPolicy: () => new ToolAccessPolicy(profile, categories),
        };
        const server = createServer(api as never);
        const client = new Client({ name: 'rf-contract', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        closers.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([client.connect(ct), server.connect(st)]);
        return { client, api };
    }
    it('advertises a strict read-only contract and supplies bounded defaults', async () => {
        const { client, api } = await setup();
        const tool = (await client.listTools()).tools.find((t) => t.name === 'getRfPlanningStatus');
        expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        expect(tool?.inputSchema.additionalProperties).toBe(false);
        expect((await client.callTool({ name: 'getRfPlanningStatus', arguments: {} })).isError).toBeFalsy();
        expect(api.getRfPlanningStatus).toHaveBeenCalledWith({ historyPage: 1, historyPageSize: 20 });
    });
    it.each([
        ['read-only', undefined],
        ['full', 'wireless:r'],
        ['full', 'wireless:rw'],
    ] as const)('is usable in %s / %s', async (profile, categories) => {
        const { client, api } = await setup(profile, categories);
        const args = { siteId: 'site', historyPage: 2, historyPageSize: 5, planningHistoryId: 'run' };
        expect((await client.callTool({ name: 'getRfPlanningStatus', arguments: args })).isError).toBeFalsy();
        expect(api.getRfPlanningStatus).toHaveBeenCalledWith(args);
    });
    it('is hidden and blocked outside wireless scope', async () => {
        const { client, api } = await setup('full', 'switching:rw');
        expect((await client.listTools()).tools.some((t) => t.name === 'getRfPlanningStatus')).toBe(false);
        expect((await client.callTool({ name: 'getRfPlanningStatus', arguments: {} })).isError).toBe(true);
        expect(api.getRfPlanningStatus).not.toHaveBeenCalled();
    });
    it.each([{ historyPage: 0 }, { historyPageSize: 101 }, { historyPage: '2' }, { unknown: true }])(
        'rejects invalid MCP inputs %j',
        async (args) => {
            const { client, api } = await setup();
            expect((await client.callTool({ name: 'getRfPlanningStatus', arguments: args })).isError).toBe(true);
            expect(api.getRfPlanningStatus).not.toHaveBeenCalled();
        }
    );
    it('classifies every planning history read as wireless and denies writes under wireless:r', () => {
        const wireless = new ToolAccessPolicy('full', 'wireless:r');
        const other = new ToolAccessPolicy('full', 'devices:r');
        for (const path of [
            '/sites/site/rfPlanning',
            '/sites/site/rfPlanning/result',
            '/sites/site/rfplanning/history',
            '/sites/site/planningHistory',
            '/sites/site/planningHistory/run',
        ]) {
            expect(() => wireless.assertOperation('GET', path)).not.toThrow();
            expect(() => other.assertOperation('GET', path)).toThrow();
            expect(() => wireless.assertOperation('POST', path)).toThrow();
        }
    });
});
