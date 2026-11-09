import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { registerDescribeApiOperationTool } from '../../src/tools/describeApiOperation.js';
import { registerExecuteApiOperationTool } from '../../src/tools/executeApiOperation.js';
import { registerSearchApiOperationsTool } from '../../src/tools/searchApiOperations.js';

const pathParameters = [
    { name: 'omadacId', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'siteId', in: 'path', required: true, schema: { type: 'string' } },
];
const document = {
    openapi: '3.0.1',
    info: { title: 'Discovery protocol fixture', version: '1' },
    paths: {
        '/openapi/v1/{omadacId}/sites/{siteId}/devices': {
            get: { operationId: 'getDevices', summary: 'List devices', tags: ['Device'], parameters: pathParameters, responses: {} },
        },
        '/openapi/v1/{omadacId}/sites/{siteId}/devices/{deviceMac}/name': {
            patch: {
                operationId: 'renameDevice',
                summary: 'Rename a device',
                tags: ['Device'],
                parameters: [...pathParameters, { name: 'deviceMac', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: { name: { type: 'string', minLength: 1 } },
                                required: ['name'],
                                additionalProperties: false,
                            },
                        },
                    },
                },
                responses: {},
            },
        },
    },
};

describe('discovery tools through MCP', () => {
    const close: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(close.splice(0).map((fn) => fn()));
    });

    async function connect(readOnly = false) {
        const catalogue = new OperationCatalog(document, 'live');
        const request = {
            request: vi.fn().mockResolvedValue({ errorCode: 0, result: [] }),
            ensureSuccess: vi.fn((response) => {
                if (response.errorCode !== 0) throw new Error(response.msg);
                return response.result;
            }),
        };
        // The underlying client is full-access. The trusted adapter policy must still
        // restrict a read-only MCP server rather than merely changing annotations.
        const api = {
            searchApiOperations: vi.fn((options, policy) => catalogue.search({ ...options, readOnly: policy.readOnly })),
            describeApiOperation: vi.fn((id, policy) => catalogue.describe(id, { readOnly: policy.readOnly })),
            executeApiOperation: vi.fn((options, policy) =>
                executeDiscoveredOperation(catalogue, request as unknown as RequestHandler, options, {
                    omadacId: 'controller',
                    siteId: 'default-site',
                    readOnly: policy.readOnly,
                })
            ),
        };
        const server = new McpServer({ name: 'discovery-protocol-test', version: '1' });
        registerSearchApiOperationsTool(server, api as unknown as OmadaClient, { readOnly });
        registerDescribeApiOperationTool(server, api as unknown as OmadaClient, { readOnly });
        registerExecuteApiOperationTool(server, api as unknown as OmadaClient, { readOnly });
        const client = new Client({ name: 'discovery-protocol-client', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        close.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(st), client.connect(ct)]);
        return { api, request, client };
    }

    it('searches, describes and executes a real indexed GET through MCP', async () => {
        const { client, request } = await connect();
        const search = await client.callTool({ name: 'searchApiOperations', arguments: { query: 'list devices' } });
        expect(search.isError).toBeFalsy();
        expect(search.content).toEqual([expect.objectContaining({ text: expect.stringContaining('getDevices') })]);
        const description = await client.callTool({ name: 'describeApiOperation', arguments: { operationId: 'getDevices' } });
        expect(description.isError).toBeFalsy();
        expect(description.content).toEqual([expect.objectContaining({ text: expect.stringContaining('siteId') })]);
        const result = await client.callTool({ name: 'executeApiOperation', arguments: { operationId: 'getDevices' } });
        expect(result.isError).toBeFalsy();
        expect(request.request).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ method: 'GET', url: '/openapi/v1/controller/sites/default-site/devices' })
        );
    });

    it('previews writes by default and sends only an explicitly requested valid write', async () => {
        const { client, request } = await connect();
        const arguments_ = { operationId: 'renameDevice', params: { deviceMac: 'AA-BB-CC-DD-EE-FF' }, body: { name: 'new name' } };
        const preview = await client.callTool({ name: 'executeApiOperation', arguments: arguments_ });
        expect(preview.isError).toBeFalsy();
        expect(request.request).not.toHaveBeenCalled();
        const write = await client.callTool({ name: 'executeApiOperation', arguments: { ...arguments_, dryRun: false } });
        expect(write.isError).toBeFalsy();
        expect(request.request).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                method: 'PATCH',
                url: '/openapi/v1/controller/sites/default-site/devices/AA-BB-CC-DD-EE-FF/name',
                data: { name: 'new name' },
            })
        );
    });

    it('rejects malformed outer inputs and invalid operation bodies before controller I/O', async () => {
        const { client, api, request } = await connect();
        const invalidSchema = await client.callTool({ name: 'searchApiOperations', arguments: { limit: 51 } });
        expect(invalidSchema.isError).toBe(true);
        expect(api.searchApiOperations).not.toHaveBeenCalled();
        const invalidBody = await client.callTool({
            name: 'executeApiOperation',
            arguments: { operationId: 'renameDevice', params: { deviceMac: 'AA-BB-CC-DD-EE-FF' }, body: { name: 42 }, dryRun: false },
        });
        expect(invalidBody.isError).toBe(true);
        expect(request.request).not.toHaveBeenCalled();
    });

    it('keeps search, describe and execution read-only even over a full-access underlying client', async () => {
        const { client, api, request } = await connect(true);
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(3);
        expect(tools.every((tool) => tool.annotations?.readOnlyHint && tool.annotations.destructiveHint === false)).toBe(true);
        const search = await client.callTool({ name: 'searchApiOperations', arguments: { query: 'rename device' } });
        expect(search.isError).toBeFalsy();
        expect(search.content).toEqual([expect.objectContaining({ text: expect.not.stringContaining('renameDevice') })]);
        const describedWrite = await client.callTool({ name: 'describeApiOperation', arguments: { operationId: 'renameDevice' } });
        expect(describedWrite.isError).toBe(true);
        for (const dryRun of [true, false]) {
            const write = await client.callTool({
                name: 'executeApiOperation',
                arguments: { operationId: 'renameDevice', params: { deviceMac: 'AA-BB-CC-DD-EE-FF' }, body: { name: 'new name' }, dryRun },
            });
            expect(write.isError).toBe(true);
        }
        const attemptedOverride = await client.callTool({
            name: 'executeApiOperation',
            arguments: { operationId: 'renameDevice', dryRun: false, policy: { readOnly: false } },
        });
        expect(attemptedOverride.isError).toBe(true);
        expect(api.executeApiOperation).toHaveBeenCalledTimes(2);
        expect(request.request).not.toHaveBeenCalled();
        const read = await client.callTool({ name: 'executeApiOperation', arguments: { operationId: 'getDevices' } });
        expect(read.isError).toBeFalsy();
        expect(request.request).toHaveBeenCalledTimes(1);
    });
});
