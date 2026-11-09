import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerCreateDhcpReservationTool } from '../../src/tools/createDhcpReservation.js';
import { registerDeleteDhcpReservationTool } from '../../src/tools/deleteDhcpReservation.js';
import { registerListDhcpReservationsTool } from '../../src/tools/listDhcpReservations.js';
import { registerUpdateDhcpReservationTool } from '../../src/tools/updateDhcpReservation.js';

const MAC = 'AA-BB-CC-DD-EE-FF';
const reservation = { mac: MAC, netId: 'network-1', status: true, ip: '192.0.2.50' };

describe('DHCP reservation MCP tools', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((close) => close()));
    });

    async function connect() {
        const stub = {
            listDhcpReservations: vi.fn().mockResolvedValue([reservation]),
            createDhcpReservation: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
            updateDhcpReservation: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
            deleteDhcpReservation: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
        };
        const server = new McpServer({ name: 'dhcp-test', version: '1.0.0' });
        registerListDhcpReservationsTool(server, stub as never);
        registerCreateDhcpReservationTool(server, stub as never);
        registerUpdateDhcpReservationTool(server, stub as never);
        registerDeleteDhcpReservationTool(server, stub as never);
        const client = new Client({ name: 'dhcp-test-client', version: '1.0.0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        closers.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(st), client.connect(ct)]);
        return { client, stub };
    }

    it('advertises reads separately from strict, destructive writes', async () => {
        const { client } = await connect();
        const { tools } = await client.listTools();
        expect(tools.find((tool) => tool.name === 'listDhcpReservations')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        for (const name of ['createDhcpReservation', 'updateDhcpReservation', 'deleteDhcpReservation']) {
            const tool = tools.find((entry) => entry.name === name);
            expect(tool?.annotations?.destructiveHint).toBe(true);
            expect(tool?.inputSchema.additionalProperties).toBe(false);
        }
    });

    it('forwards list search and site without mutation', async () => {
        const { client, stub } = await connect();
        const result = await client.callTool({ name: 'listDhcpReservations', arguments: { siteId: 'site-1', searchKey: '192.0.2' } });
        expect(result.isError).toBeFalsy();
        expect(stub.listDhcpReservations).toHaveBeenCalledWith('site-1', '192.0.2');
        expect(result.content).toEqual([{ type: 'text', text: JSON.stringify([reservation], null, 2) }]);
    });

    it('forwards strict create, update and delete dry-run requests', async () => {
        const { client, stub } = await connect();
        for (const request of [
            { name: 'createDhcpReservation', arguments: { siteId: 'site-1', reservation, dryRun: true } },
            { name: 'updateDhcpReservation', arguments: { siteId: 'site-1', mac: MAC, settings: { description: 'Updated' }, dryRun: true } },
            { name: 'deleteDhcpReservation', arguments: { siteId: 'site-1', mac: MAC, dryRun: true } },
        ]) {
            const result = await client.callTool(request);
            expect(result.isError).toBeFalsy();
        }
        expect(stub.createDhcpReservation).toHaveBeenCalledWith(reservation, 'site-1', true);
        expect(stub.updateDhcpReservation).toHaveBeenCalledWith(MAC, { description: 'Updated' }, 'site-1', true);
        expect(stub.deleteDhcpReservation).toHaveBeenCalledWith(MAC, 'site-1', true);
    });

    it.each([
        { ...reservation, unexpected: true },
        { ...reservation, ip: '999.0.2.50' },
        { ...reservation, mac: 'FF-FF-FF-FF-FF-FF' },
        { ...reservation, mac: 'not-a-mac' },
        { ...reservation, options: [{ code: 15, type: 0, value: 'example.test', unexpected: true }] },
        { ...reservation, description: '=formula' },
    ])('rejects invalid or unknown create fields before calling the client (%j)', async (data) => {
        const { client, stub } = await connect();
        const result = await client.callTool({ name: 'createDhcpReservation', arguments: { reservation: data } });
        expect(result.isError).toBe(true);
        expect(stub.createDhcpReservation).not.toHaveBeenCalled();
    });

    it.each([{}, { mac: MAC }, { id: 'readonly' }, { options: [{ code: 15, type: 0, value: 'example.test', id: 'readonly' }] }])(
        'rejects empty or unsupported update fields (%j)',
        async (settings) => {
            const { client, stub } = await connect();
            const result = await client.callTool({ name: 'updateDhcpReservation', arguments: { mac: MAC, settings } });
            expect(result.isError).toBe(true);
            expect(stub.updateDhcpReservation).not.toHaveBeenCalled();
        }
    );

    it('rejects root write typos instead of dropping them', async () => {
        const { client, stub } = await connect();
        const result = await client.callTool({ name: 'deleteDhcpReservation', arguments: { mac: MAC, dryrun: true } });
        expect(result.isError).toBe(true);
        expect(stub.deleteDhcpReservation).not.toHaveBeenCalled();
    });
});
