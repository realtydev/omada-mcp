import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerDiagnoseWanTool } from '../../src/tools/diagnoseWan.js';
import { registerGetTrafficHistoryTool } from '../../src/tools/getTrafficHistory.js';
import { registerGetWifiHistoryTool } from '../../src/tools/getWifiHistory.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
});
async function setup() {
    const api = {
        getTrafficHistory: vi.fn().mockResolvedValue({ collectionComplete: true }),
        getWifiHistory: vi.fn().mockResolvedValue({ collectionComplete: false }),
        diagnoseWan: vi.fn().mockResolvedValue({ collectionComplete: true }),
    };
    const server = new McpServer({ name: 'network-diagnostics-test', version: '1.0.0' });
    registerGetTrafficHistoryTool(server, api as unknown as OmadaClient);
    registerGetWifiHistoryTool(server, api as unknown as OmadaClient);
    registerDiagnoseWanTool(server, api as unknown as OmadaClient);
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    closers.push(
        () => client.close(),
        () => server.close()
    );
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { api, client };
}
describe('network diagnostics MCP adapters', () => {
    it('registers all workflows as read-only without destructive annotations', async () => {
        const { client } = await setup();
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual(['diagnoseWan', 'getTrafficHistory', 'getWifiHistory']);
        expect(tools.every((tool) => tool.annotations?.readOnlyHint && tool.annotations?.destructiveHint === false)).toBe(true);
    });
    it('forwards explicit windows, sample limits and device selectors to the client', async () => {
        const { client, api } = await setup();
        const window = { siteId: 'test-site', start: 100, end: 200, maxSamples: 10 };
        for (const [name, args] of [
            ['getTrafficHistory', window],
            ['getWifiHistory', { ...window, apMac: 'AA-BB-CC-DD-EE-FF' }],
            ['diagnoseWan', { ...window, gatewayMac: 'AA-BB-CC-DD-EE-FF' }],
        ] as const) {
            const result = await client.callTool({ name, arguments: args });
            expect(result.isError).toBeFalsy();
            expect(api[name]).toHaveBeenCalledWith(args);
        }
    });
    it('exposes a bounded portable baseline schema and rejects malformed snapshots before the client', async () => {
        const { client, api } = await setup();
        const { tools } = await client.listTools();
        for (const tool of tools) {
            const baseline = tool.inputSchema.properties?.baseline as { properties: { version: { const: number } } };
            expect(baseline.properties.version.const).toBe(1);
        }
        const result = await client.callTool({ name: 'getTrafficHistory', arguments: { baseline: { version: 999 } } });
        expect(result.isError).toBe(true);
        expect(api.getTrafficHistory).not.toHaveBeenCalled();
    });
    it('rejects aggregate point and byte budgets in the MCP schema before invoking the client', async () => {
        const { client, api } = await setup();
        const excessivePoints = {
            metrics: Array.from({ length: 11 }, () => ({ points: Array.from({ length: 1000 }, (_, offset) => ({ offset, value: 1 })) })),
        };
        const points = await client.callTool({ name: 'getTrafficHistory', arguments: { baseline: excessivePoints } });
        expect(points.isError).toBe(true);
        expect(points.content).toEqual([expect.objectContaining({ text: expect.stringContaining('total point budget') })]);
        const bytes = await client.callTool({ name: 'getTrafficHistory', arguments: { baseline: { extra: 'x'.repeat(512 * 1024) } } });
        expect(bytes.isError).toBe(true);
        expect(bytes.content).toEqual([expect.objectContaining({ text: expect.stringContaining('size limit') })]);
        expect(api.getTrafficHistory).not.toHaveBeenCalled();
    });
    it.each([
        ['getWifiHistory', { startScan: true }],
        ['diagnoseWan', { gatewayMac: '../gateway' }],
        ['getTrafficHistory', { maxSamples: 1001 }],
        ['getTrafficHistory', { maxSamples: 1.5 }],
        ['getWifiHistory', { apMac: 'AA' }],
    ])('rejects invalid or mutating flags for %s before invoking the client', async (name, args) => {
        const { client, api } = await setup();
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(Object.values(api).every((method) => method.mock.calls.length === 0)).toBe(true);
    });
});
