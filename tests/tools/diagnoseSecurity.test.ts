import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDiagnoseSecurityTool } from '../../src/tools/diagnoseSecurity.js';

describe('diagnoseSecurity protocol boundary', () => {
    const closers: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(closers.splice(0).map((close) => close()));
    });
    async function connect() {
        const server = new McpServer({ name: 'security-test', version: '1' });
        const diagnoseSecurity = vi.fn().mockResolvedValue({ collectionComplete: false, sections: {} });
        registerDiagnoseSecurityTool(server, { diagnoseSecurity } as never);
        const client = new Client({ name: 'test-client', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        closers.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([client.connect(ct), server.connect(st)]);
        return { client, diagnoseSecurity };
    }
    it('advertises read-only behavior and forwards bounded defaults', async () => {
        const { client, diagnoseSecurity } = await connect();
        const { tools } = await client.listTools();
        expect(tools[0].annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        const reply = await client.callTool({ name: 'diagnoseSecurity', arguments: { siteId: 'site', start: 100, end: 200 } });
        expect(reply.isError).toBeFalsy();
        expect(diagnoseSecurity).toHaveBeenCalledExactlyOnceWith({ siteId: 'site', start: 100, end: 200, pageSize: 100 });
    });
    it.each([{ pageSize: 201 }, { pageSize: 0 }, { scan: true }, { acknowledge: true }, { archived: true }, { start: -1 }])(
        'rejects invalid or mutating options before collection: %j',
        async (args) => {
            const { client, diagnoseSecurity } = await connect();
            expect((await client.callTool({ name: 'diagnoseSecurity', arguments: args })).isError).toBe(true);
            expect(diagnoseSecurity).not.toHaveBeenCalled();
        }
    );
});
