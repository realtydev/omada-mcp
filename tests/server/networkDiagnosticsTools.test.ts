import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerDiagnoseWanTool } from '../../src/tools/diagnoseWan.js';
import { registerDiagnoseWifiTool } from '../../src/tools/diagnoseWifi.js';
import { registerGetTrafficHistoryTool } from '../../src/tools/getTrafficHistory.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
});
async function setup() {
    const api = {
        getTrafficHistory: vi.fn().mockResolvedValue({ collectionComplete: true }),
        diagnoseWifi: vi.fn().mockResolvedValue({ collectionComplete: false }),
        diagnoseWan: vi.fn().mockResolvedValue({ collectionComplete: true }),
    };
    const server = new McpServer({ name: 'network-diagnostics-test', version: '1.0.0' });
    registerGetTrafficHistoryTool(server, api as unknown as OmadaClient);
    registerDiagnoseWifiTool(server, api as unknown as OmadaClient);
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
        expect(tools.map((tool) => tool.name).sort()).toEqual(['diagnoseWan', 'diagnoseWifi', 'getTrafficHistory']);
        expect(tools.every((tool) => tool.annotations?.readOnlyHint && tool.annotations?.destructiveHint === false)).toBe(true);
    });
    it('forwards explicit windows, sample limits and device selectors to the client', async () => {
        const { client, api } = await setup();
        const window = { siteId: 'test-site', start: 100, end: 200, maxSamples: 10 };
        for (const [name, args] of [
            ['getTrafficHistory', window],
            ['diagnoseWifi', { ...window, apMac: 'AA-BB-CC-DD-EE-FF' }],
            ['diagnoseWan', { ...window, gatewayMac: 'AA-BB-CC-DD-EE-FF' }],
        ] as const) {
            const result = await client.callTool({ name, arguments: args });
            expect(result.isError).toBeFalsy();
            expect(api[name]).toHaveBeenCalledWith(args);
        }
    });
    it.each([
        ['diagnoseWifi', { startScan: true }],
        ['diagnoseWan', { gatewayMac: '../gateway' }],
        ['getTrafficHistory', { maxSamples: 1001 }],
        ['getTrafficHistory', { maxSamples: 1.5 }],
        ['diagnoseWifi', { apMac: 'AA' }],
    ])('rejects invalid or mutating flags for %s before invoking the client', async (name, args) => {
        const { client, api } = await setup();
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(Object.values(api).every((method) => method.mock.calls.length === 0)).toBe(true);
    });
});
