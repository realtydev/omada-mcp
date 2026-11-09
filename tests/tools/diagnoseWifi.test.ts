import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDiagnoseWifiTool } from '../../src/tools/diagnoseWifi.js';

describe('diagnoseWifi protocol boundary', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((close) => close()));
    });
    async function connect() {
        const server = new McpServer({ name: 'wifi-test', version: '1' });
        const diagnoseWifi = vi.fn().mockResolvedValue({ collectionComplete: false, observations: [] });
        registerDiagnoseWifiTool(server, { diagnoseWifi } as never);
        const client = new Client({ name: 'test-client', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        closers.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([client.connect(ct), server.connect(st)]);
        return { client, diagnoseWifi };
    }
    it('advertises read-only behavior and forwards bounded audit options', async () => {
        const { client, diagnoseWifi } = await connect();
        const { tools } = await client.listTools();
        expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        const reply = await client.callTool({ name: 'diagnoseWifi', arguments: { siteId: 'site', maxAps: 2 } });
        expect(reply.isError).toBeFalsy();
        expect(diagnoseWifi).toHaveBeenCalledExactlyOnceWith({ siteId: 'site', maxAps: 2 });
    });
    it.each([{ maxAps: 26 }, { maxAps: 0 }, { startScan: true }, { baseline: { version: 1 } }])(
        'rejects invalid or mutating input before collection: %j',
        async (args) => {
            const { client, diagnoseWifi } = await connect();
            expect((await client.callTool({ name: 'diagnoseWifi', arguments: args })).isError).toBe(true);
            expect(diagnoseWifi).not.toHaveBeenCalled();
        }
    );
});
