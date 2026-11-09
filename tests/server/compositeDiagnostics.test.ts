import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticsOperations } from '../../src/omadaClient/diagnostics.js';
import { registerDiagnoseClientTool } from '../../src/tools/diagnoseClient.js';
import { registerDiagnoseLogsTool } from '../../src/tools/diagnoseLogs.js';

const MAC = 'AA-BB-CC-DD-EE-FF';

describe('composite diagnostics through MCP', () => {
    const cleanup: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((close) => close()));
    });

    async function connect() {
        const sources = {
            listClients: vi.fn().mockResolvedValue([]),
            listDevices: vi.fn().mockResolvedValue([]),
            getSiteTopology: vi.fn().mockRejectedValue(new Error('Topology requires web credentials')),
            getClientHistory: vi.fn().mockResolvedValue({ clientMac: MAC, sessions: [] }),
            listEvents: vi.fn().mockResolvedValue({ data: [], totalRows: 0 }),
            listAlerts: vi.fn().mockResolvedValue({ data: [], totalRows: 0 }),
        };
        const ops = new DiagnosticsOperations(sources);
        const facade = {
            diagnoseClient: vi.fn(ops.diagnoseClient.bind(ops)),
            diagnoseLogs: vi.fn(ops.diagnoseLogs.bind(ops)),
        };
        const server = new McpServer({ name: 'composite-diagnostic-test', version: '1.0.0' });
        registerDiagnoseClientTool(server, facade as never);
        registerDiagnoseLogsTool(server, facade as never);
        const client = new Client({ name: 'composite-test-client', version: '1.0.0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        cleanup.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(st), client.connect(ct)]);
        return { client, facade, sources };
    }

    it('advertises read-only schemas and preserves cross-field time validation', async () => {
        const { client, facade } = await connect();
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual(['diagnoseClient', 'diagnoseLogs']);
        expect(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false)).toBe(true);
        const reversed = await client.callTool({ name: 'diagnoseClient', arguments: { clientMac: MAC, timeStart: 200, timeEnd: 100 } });
        expect(reversed.isError).toBe(true);
        expect(facade.diagnoseClient).not.toHaveBeenCalled();
        const badMac = await client.callTool({ name: 'diagnoseClient', arguments: { clientMac: 'AA-BB' } });
        expect(badMac.isError).toBe(true);
        expect(facade.diagnoseClient).not.toHaveBeenCalled();
        const unknown = await client.callTool({ name: 'diagnoseLogs', arguments: { launchScan: true } });
        expect(unknown.isError).toBe(true);
        expect(facade.diagnoseLogs).not.toHaveBeenCalled();
    });

    it('returns missing client and topology evidence as a partial diagnostic result', async () => {
        const { client, facade, sources } = await connect();
        const result = await client.callTool({
            name: 'diagnoseClient',
            arguments: { clientMac: MAC, siteId: 'site-1', timeStart: 100, timeEnd: 200 },
        });
        expect(result.isError).toBeFalsy();
        expect(facade.diagnoseClient).toHaveBeenCalledWith(MAC, 'site-1', 100, 200);
        expect(sources.getClientHistory).toHaveBeenCalledWith({ clientMac: MAC, siteId: 'site-1', timeStart: 100, timeEnd: 200, roamTimeline: true });
        expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('"status": "not_found"') })]);
        expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('"collectionComplete": false') })]);
        expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('Topology requires web credentials') })]);
    });

    it('enforces the page cap before collection and passes one requested log window', async () => {
        const { client, facade, sources } = await connect();
        const oversized = await client.callTool({ name: 'diagnoseLogs', arguments: { pageSize: 201 } });
        expect(oversized.isError).toBe(true);
        expect(facade.diagnoseLogs).not.toHaveBeenCalled();
        const reversed = await client.callTool({ name: 'diagnoseLogs', arguments: { timeStart: 200, timeEnd: 100 } });
        expect(reversed.isError).toBe(true);
        const result = await client.callTool({ name: 'diagnoseLogs', arguments: { siteId: 'site-1', timeStart: 100, timeEnd: 200 } });
        expect(result.isError).toBeFalsy();
        expect(facade.diagnoseLogs).toHaveBeenCalledWith('site-1', 100, 200, 100);
        expect(sources.listEvents).toHaveBeenCalledWith('site-1', 1, 100, 100, 200);
        expect(sources.listAlerts).toHaveBeenCalledWith('site-1', 1, 100, 100, 200);
    });
});
