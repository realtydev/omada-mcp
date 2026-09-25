import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { createServer } from '../../src/server/common.js';

/**
 * Regression test for the incident where an old server build silently accepted a `dryRun` field
 * it didn't know about and ran a real write. The MCP SDK's registerTool discards a zod schema's
 * `.strict()`-ness if only its `.shape` is passed as `inputSchema` — it reconstructs a fresh,
 * non-strict object from the shape. This exercises the actual protocol path (a real Client talking
 * to a real Server over an in-memory transport) rather than asserting on the zod schema in
 * isolation, since a superficial `.strict()` fix that didn't also change how the schema is handed
 * to `registerTool` would look correct here while still reproducing the incident.
 */
describe('write tool schemas reject unrecognized fields end-to-end', () => {
    async function connectedClient() {
        // A stub is enough: registerAllTools only reads a client method when a tool is actually invoked.
        const stubClient = {
            setApRadio: vi.fn().mockResolvedValue({ dryRun: false, written: false, band: '5g', changes: [] }),
        } as never;

        const server = createServer(stubClient);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test-client', version: '0.0.0' });

        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        return { client, stubClient };
    }

    it('should reject an unrecognized field on a write tool (the setApRadio/dryRun incident) without invoking the client', async () => {
        const { client, stubClient } = await connectedClient();

        const result = await client.callTool({
            name: 'setApRadio',
            // channelWidth is a real field; dryRun did not exist on this tool's schema at the time of the incident,
            // so an unrecognized-field test needs a field that is genuinely not part of the schema, not dryRun itself.
            arguments: { apMac: 'AA-BB-CC-DD-EE-FF', band: '5g', channelWidth: 5, notAKnownField: true },
        });

        expect(result.isError).toBe(true);
        expect(stubClient.setApRadio).not.toHaveBeenCalled();
    });

    it('should accept a call to the same tool that only uses recognized fields', async () => {
        const { client, stubClient } = await connectedClient();

        const result = await client.callTool({
            name: 'setApRadio',
            arguments: { apMac: 'AA-BB-CC-DD-EE-FF', band: '5g', channelWidth: 5, dryRun: true },
        });

        expect(result.isError).toBeFalsy();
        expect(stubClient.setApRadio).toHaveBeenCalledWith('AA-BB-CC-DD-EE-FF', '5g', { channelWidth: 5 }, undefined, true);
    });

    it('should declare every destructive (write) tool as rejecting additional properties in its advertised schema', async () => {
        const { client } = await connectedClient();

        const { tools } = await client.listTools();
        const writeTools = tools.filter((tool) => tool.annotations?.destructiveHint === true);

        expect(writeTools.length).toBeGreaterThan(30); // sanity: this should cover every write tool, not a handful

        const notStrict = writeTools.filter((tool) => (tool.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false);
        expect(notStrict.map((tool) => tool.name)).toEqual([]);
    });
});
