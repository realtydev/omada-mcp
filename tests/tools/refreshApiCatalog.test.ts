import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerRefreshApiCatalogTool } from '../../src/tools/refreshApiCatalog.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
});
async function connect() {
    const api = { refreshApiCatalog: vi.fn().mockResolvedValue({ status: 'refreshed', current: { source: 'bundled', operations: 1676 } }) };
    const server = new McpServer({ name: 'refresh-tool-test', version: '1' });
    registerRefreshApiCatalogTool(server, api as unknown as OmadaClient);
    const client = new Client({ name: 'refresh-tool-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    closers.push(
        () => client.close(),
        () => server.close()
    );
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, api };
}
describe('refresh catalogue tool', () => {
    it('exposes an empty strict schema and controller-read annotations, and invokes exactly one refresh', async () => {
        const { client, api } = await connect();
        const { tools } = await client.listTools();
        expect(tools[0]).toMatchObject({
            name: 'refreshApiCatalog',
            inputSchema: { type: 'object', additionalProperties: false },
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
        });
        const result = await client.callTool({ name: 'refreshApiCatalog', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(api.refreshApiCatalog).toHaveBeenCalledExactlyOnceWith();
        expect(result.content).toEqual([
            { type: 'text', text: JSON.stringify({ status: 'refreshed', current: { source: 'bundled', operations: 1676 } }, null, 2) },
        ]);
    });
    it.each([{ url: 'https://external.invalid' }, { apiSpec: 'live' }, { force: true }])(
        'rejects caller source overrides %j before client invocation',
        async (args) => {
            const { client, api } = await connect();
            const result = await client.callTool({ name: 'refreshApiCatalog', arguments: args });
            expect(result.isError).toBe(true);
            expect(api.refreshApiCatalog).not.toHaveBeenCalled();
        }
    );
    it('preserves explicit failed-refresh metadata instead of claiming a refresh succeeded', async () => {
        const { client, api } = await connect();
        api.refreshApiCatalog.mockResolvedValueOnce({ status: 'failed', cacheRetained: true } as never);
        const result = await client.callTool({ name: 'refreshApiCatalog', arguments: {} });
        const content = result.content as Array<{ text: string }>;
        expect(JSON.parse(content[0].text)).toEqual({ status: 'failed', cacheRetained: true });
    });
});
