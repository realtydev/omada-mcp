import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import { CatalogLoader } from '../../src/discovery/load.js';
import { DiscoveryOperations } from '../../src/omadaClient/discovery.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { categoryForPath, ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const MSP = '/openapi/v1/msp/{mspId}';
const document = {
    openapi: '3.1.0',
    paths: {
        [`${MSP}/users`]: {
            get: { operationId: 'users' },
            post: {
                operationId: 'createUser',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { type: 'object', required: ['level'], properties: { level: { const: 1 } }, unevaluatedProperties: false },
                        },
                    },
                },
            },
        },
        [`${MSP}/logs/export`]: {
            get: {
                operationId: 'downloadLogs',
                responses: { 200: { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
            },
        },
        '/openapi/v1/{omadacId}/sites/{siteId}/wireless-network/wlans': { get: { operationId: 'wlans' } },
    },
};
function setup(categories: string, mspId: string | undefined = 'msp-1') {
    const request = { request: vi.fn().mockResolvedValue({ errorCode: 0, result: [] }), ensureSuccess: vi.fn((reply) => reply.result) };
    const service = new DiscoveryOperations(
        request as unknown as RequestHandler,
        {} as AxiosInstance,
        { omadacId: 'controller', siteId: 'site', mspId, toolCategories: categories },
        new CatalogLoader(async () => document, 'auto')
    );
    return { service, request };
}

describe('MSP discovery policy integration', () => {
    it('requires explicit MSP authority independently of dedicated controller categories', () => {
        const path = `${MSP}/customers/{customerId}/sites/{siteId}/wireless-network/wlans`;
        expect(categoryForPath(path)).toBe('msp');
        expect(categoryForPath('/openapi/v2/msp/{mspId}/users')).toBe('msp');
        expect(new ToolAccessPolicy('full', 'system:rw,wireless:rw').allowsOperation('GET', path)).toBe(false);
        expect(new ToolAccessPolicy('full', 'msp:r').allowsOperation('GET', path)).toBe(true);
        expect(new ToolAccessPolicy('full', 'msp:r').allowsOperation('POST', path)).toBe(false);
        expect(new ToolAccessPolicy('full', 'all:rw').allowsOperation('POST', path)).toBe(true);
        expect(new ToolAccessPolicy('read-only', 'msp:rw').allowsOperation('POST', path)).toBe(false);
    });

    it.each(['users/../sites', 'users%2froles', 'users?x=1', 'users#x', 'users\\roles', 'users//roles'])(
        'rejects malformed MSP route %s during classification',
        (suffix) => {
            expect(categoryForPath(`${MSP}/${suffix}`)).toBeUndefined();
        }
    );

    it('filters search, description, preview and execution through the same MSP scope', async () => {
        const { service, request } = setup('msp:r,wireless:rw');
        const results = (await service.searchApiOperations({ limit: 50 })) as { operations: { operationId: string }[] };
        expect(results.operations.map((op) => op.operationId).sort()).toEqual(['downloadLogs', 'users', 'wlans']);
        await expect(service.describeApiOperation('createUser')).rejects.toThrow('inaccessible');
        await expect(service.executeApiOperation({ operationId: 'createUser', body: { level: 1 } })).rejects.toThrow('not permitted');
        await expect(service.executeApiOperation({ operationId: 'users' })).resolves.toMatchObject({
            request: { path: '/openapi/v1/msp/msp-1/users' },
        });
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('preserves JSON Schema 2020 validation and explicit MSP configuration under scoped access', async () => {
        const { service, request } = setup('msp:rw');
        await expect(service.executeApiOperation({ operationId: 'createUser', body: { level: 1, extra: true } })).rejects.toThrow('unevaluated');
        await expect(service.executeApiOperation({ operationId: 'createUser', body: { level: 1 } })).resolves.toMatchObject({
            dryRun: true,
            written: false,
        });
        await expect(service.executeApiOperation({ operationId: 'users', params: { mspId: 'other' } })).rejects.toThrow('overridden');
        const missing = new DiscoveryOperations(
            request as unknown as RequestHandler,
            {} as AxiosInstance,
            { omadacId: 'controller', toolCategories: 'msp:r' },
            new CatalogLoader(async () => document, 'auto')
        );
        await expect(missing.executeApiOperation({ operationId: 'users' })).rejects.toThrow('OMADA_MSP_ID');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('denies transfers before filesystem access and preserves policy-only read-only restrictions', async () => {
        const { service, request } = setup('wireless:rw');
        await expect(service.executeApiOperation({ operationId: 'downloadLogs', downloadFile: 'log.bin' })).rejects.toThrow('not permitted');
        const { service: allowed } = setup('msp:rw');
        await expect(
            allowed.executeApiOperation({ operationId: 'downloadLogs', downloadFile: 'log.bin' }, { accessPolicy: new ToolAccessPolicy('read-only') })
        ).rejects.toThrow('Read-only');
        await expect(
            executeDiscoveredOperation(
                new OperationCatalog(document, 'live'),
                request as unknown as RequestHandler,
                { operationId: 'downloadLogs', downloadFile: 'log.bin' },
                { omadacId: 'controller', mspId: 'msp-1', readOnly: false, accessPolicy: new ToolAccessPolicy('read-only', 'msp:r') }
            )
        ).rejects.toThrow('Read-only');
        expect(request.request).not.toHaveBeenCalled();
    });
});
