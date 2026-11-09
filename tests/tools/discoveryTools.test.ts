import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerDescribeApiOperationTool } from '../../src/tools/describeApiOperation.js';
import { registerExecuteApiOperationTool } from '../../src/tools/executeApiOperation.js';
import { registerSearchApiOperationsTool } from '../../src/tools/searchApiOperations.js';

function setup(readOnly = false) {
    const server = { registerTool: vi.fn() };
    const client = {
        searchApiOperations: vi.fn().mockResolvedValue({ source: 'live', operations: [] }),
        describeApiOperation: vi.fn().mockResolvedValue({ source: 'bundled', operationId: 'getDevices' }),
        executeApiOperation: vi.fn().mockResolvedValue({ dryRun: true, written: false }),
    };
    registerSearchApiOperationsTool(server as unknown as McpServer, client as unknown as OmadaClient, { readOnly });
    registerDescribeApiOperationTool(server as unknown as McpServer, client as unknown as OmadaClient, { readOnly });
    registerExecuteApiOperationTool(server as unknown as McpServer, client as unknown as OmadaClient, { readOnly });
    const tools = Object.fromEntries(server.registerTool.mock.calls.map(([name, config, handler]) => [name, { config, handler }]));
    return { tools, client };
}

describe('discovery tool adapters', () => {
    it('registers strict bounded schemas without accepting a caller-supplied policy', () => {
        const { tools } = setup();
        const search = tools.searchApiOperations.config.inputSchema;
        expect(search.safeParse({}).success).toBe(true);
        expect(search.safeParse({ query: 'wireless', limit: 50 }).success).toBe(true);
        for (const value of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { query: '' }, { tag: ' ' }, { method: 'HEAD' }, { readOnly: false }]) {
            expect(search.safeParse(value).success).toBe(false);
        }
        const describeSchema = tools.describeApiOperation.config.inputSchema;
        expect(describeSchema.safeParse({ operationId: 'getDevices' }).success).toBe(true);
        expect(describeSchema.safeParse({ operationId: ' ' }).success).toBe(false);
        expect(describeSchema.safeParse({ operationId: 'getDevices', readOnly: false }).success).toBe(false);
        const execute = tools.executeApiOperation.config.inputSchema;
        expect(execute.safeParse({ operationId: 'getDevices' }).success).toBe(true);
        expect(execute.safeParse({ operationId: 'write', body: [{ value: true }], dryRun: true }).success).toBe(true);
        for (const value of [{ operationId: '' }, { operationId: 'write', dryRun: 'false' }, { operationId: 'write', policy: { readOnly: false } }]) {
            expect(execute.safeParse(value).success).toBe(false);
        }
    });

    it('advertises conservative execution annotations in full mode and GET-only annotations in read-only mode', () => {
        const full = setup().tools;
        const readOnly = setup(true).tools;
        for (const name of ['searchApiOperations', 'describeApiOperation']) {
            expect(full[name].config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        }
        expect(full.executeApiOperation.config.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
        expect(readOnly.executeApiOperation.config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        expect(readOnly.executeApiOperation.config.description).toContain('GET operations only');
    });

    it('forwards inputs and trusted read-only policy separately without defaulting dryRun', async () => {
        const { tools, client } = setup(true);
        const query = { query: 'VPN', method: 'GET', limit: 5 };
        const execution = { operationId: 'getDevices', params: { siteId: 'site' } };
        await tools.searchApiOperations.handler(query, {});
        await tools.describeApiOperation.handler({ operationId: 'getDevices' }, {});
        const result = await tools.executeApiOperation.handler(execution, {});
        expect(client.searchApiOperations).toHaveBeenCalledExactlyOnceWith(query, { readOnly: true });
        expect(client.describeApiOperation).toHaveBeenCalledExactlyOnceWith('getDevices', { readOnly: true });
        expect(client.executeApiOperation).toHaveBeenCalledExactlyOnceWith(execution, { readOnly: true });
        expect(JSON.parse(result.content[0].text)).toEqual({ dryRun: true, written: false });
    });

    it('preserves controller errors through the shared handler', async () => {
        const { tools, client } = setup();
        client.executeApiOperation.mockRejectedValue(new Error('GET /devices (HTTP 403) - permission denied'));
        await expect(tools.executeApiOperation.handler({ operationId: 'getDevices' }, {})).rejects.toThrow('HTTP 403');
    });
});
