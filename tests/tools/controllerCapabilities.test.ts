import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGetControllerCapabilitiesTool } from '../../src/tools/getControllerCapabilities.js';

describe('controller capabilities MCP tool', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((close) => close()));
    });

    async function connect() {
        const stub = { getControllerCapabilities: vi.fn().mockResolvedValue({ controller: { status: 'ok', mode: 'classic' } }) };
        const server = new McpServer({ name: 'capabilities-test', version: '1' });
        registerGetControllerCapabilitiesTool(server, stub as never);
        const client = new Client({ name: 'capabilities-test-client', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        closers.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(st), client.connect(ct)]);
        return { client, stub };
    }

    it('advertises strict read-only evidence collection', async () => {
        const { client } = await connect();
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(1);
        expect(tools[0]).toMatchObject({
            name: 'getControllerCapabilities',
            inputSchema: { additionalProperties: false },
            annotations: { readOnlyHint: true, destructiveHint: false },
        });
    });

    it('forwards paired explicit SSID evidence options', async () => {
        const { client, stub } = await connect();
        const options = { siteId: 'site', wlanId: 'wlan', ssidId: 'ssid' };
        const result = await client.callTool({ name: 'getControllerCapabilities', arguments: options });
        expect(result.isError).toBeFalsy();
        expect(stub.getControllerCapabilities).toHaveBeenCalledExactlyOnceWith(options);
    });

    it('allows a metadata-only call', async () => {
        const { client, stub } = await connect();
        expect((await client.callTool({ name: 'getControllerCapabilities', arguments: {} })).isError).toBeFalsy();
        expect(stub.getControllerCapabilities).toHaveBeenCalledExactlyOnceWith({});
    });

    it.each([{ wlanId: 'wlan' }, { ssidId: 'ssid' }, { siteId: '' }, { unknown: true }])(
        'rejects invalid options before the facade: %j',
        async (options) => {
            const { client, stub } = await connect();
            expect((await client.callTool({ name: 'getControllerCapabilities', arguments: options })).isError).toBe(true);
            expect(stub.getControllerCapabilities).not.toHaveBeenCalled();
        }
    );
});
