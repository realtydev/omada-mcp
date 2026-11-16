import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGetClientApplicationTrafficTool } from '../../src/tools/getClientApplicationTraffic.js';

describe('client application traffic MCP boundary', () => {
    const close: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(close.splice(0).map((fn) => fn()));
    });
    async function setup() {
        const server = new McpServer({ name: 'app-test', version: '1' });
        const getClientApplicationTraffic = vi.fn().mockResolvedValue({ readOnly: true, collectionComplete: false });
        registerGetClientApplicationTrafficTool(server, { getClientApplicationTraffic } as never);
        const client = new Client({ name: 'app-test-client', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        close.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([client.connect(ct), server.connect(st)]);
        return { client, getClientApplicationTraffic };
    }
    it('registers one strict, read-only tool and forwards defaults', async () => {
        const { client, getClientApplicationTraffic } = await setup();
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(1);
        expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        expect(tools[0].inputSchema.additionalProperties).toBe(false);
        expect((await client.callTool({ name: 'getClientApplicationTraffic', arguments: { clientMac: 'AA-BB-CC-DD-EE-01' } })).isError).toBeFalsy();
        expect(getClientApplicationTraffic).toHaveBeenCalledExactlyOnceWith({ clientMac: 'AA-BB-CC-DD-EE-01', maxApplications: 100 });
    });
    it.each([
        {},
        { clientMac: '../scan' },
        { clientMac: 'AA-BB-CC-DD-EE-01', enable: true },
        { clientMac: 'AA-BB-CC-DD-EE-01', maxApplications: 501 },
    ])('rejects invalid input before dispatch %j', async (args) => {
        const { client, getClientApplicationTraffic } = await setup();
        expect((await client.callTool({ name: 'getClientApplicationTraffic', arguments: args })).isError).toBe(true);
        expect(getClientApplicationTraffic).not.toHaveBeenCalled();
    });
});
