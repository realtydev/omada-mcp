import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerGetGatewayWanSpeedTestResultsTool } from '../../src/tools/getGatewayWanSpeedTestResults.js';
import { registerGetSiteTopologyTool } from '../../src/tools/getSiteTopology.js';
import { registerListVpnConnectionsTool } from '../../src/tools/listVpnConnections.js';

describe('monitoring tools through MCP', () => {
    const close: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(close.splice(0).map((fn) => fn()));
    });
    async function connect() {
        const api = {
            getSiteTopology: vi.fn().mockResolvedValue({ topologyArray: [], lastUpdateTime: 1 }),
            listVpnConnections: vi.fn().mockResolvedValue([]),
            getGatewayWanSpeedTestResults: vi.fn().mockResolvedValue({ status: 0, portSpeedResults: [] }),
        };
        const server = new McpServer({ name: 'monitoring-test', version: '1' });
        registerGetSiteTopologyTool(server, api as unknown as OmadaClient);
        registerListVpnConnectionsTool(server, api as unknown as OmadaClient);
        registerGetGatewayWanSpeedTestResultsTool(server, api as unknown as OmadaClient);
        const client = new Client({ name: 'monitoring-test-client', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        close.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(st), client.connect(ct)]);
        return { api, client };
    }

    it('advertises read-only schemas and validates before calling the controller', async () => {
        const { api, client } = await connect();
        const listed = await client.listTools();
        expect(listed.tools).toHaveLength(3);
        expect(listed.tools.every((t) => t.annotations?.readOnlyHint && t.annotations?.destructiveHint === false)).toBe(true);
        const bad = await client.callTool({ name: 'listVpnConnections', arguments: { kind: 'invalid' } });
        expect(bad.isError).toBe(true);
        expect(api.listVpnConnections).not.toHaveBeenCalled();
        const missing = await client.callTool({ name: 'getGatewayWanSpeedTestResults', arguments: {} });
        expect(missing.isError).toBe(true);
        expect(api.getGatewayWanSpeedTestResults).not.toHaveBeenCalled();
    });

    it('passes the selected VPN protocol and returns empty success without pretending an error', async () => {
        const { api, client } = await connect();
        const result = await client.callTool({ name: 'listVpnConnections', arguments: { kind: 's2s', vpnType: 2, siteId: 'site' } });
        expect(result.isError).toBeFalsy();
        expect(api.listVpnConnections).toHaveBeenCalledWith({ kind: 's2s', vpnType: 2, siteId: 'site' });
        expect(result.content).toEqual([{ type: 'text', text: '[]' }]);
    });

    it('preserves topology access errors in the tool result', async () => {
        const { api, client } = await connect();
        api.getSiteTopology.mockRejectedValue(new Error('Web credentials required'));
        const result = await client.callTool({ name: 'getSiteTopology', arguments: {} });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('Web credentials required') })]);
    });
});
