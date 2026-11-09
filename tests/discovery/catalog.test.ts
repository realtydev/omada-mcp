import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type ApiDocument, OperationCatalog } from '../../src/discovery/catalog.js';

const PREFIX = '/openapi/v1/{omadacId}';

function fixture(paths: ApiDocument = {}): ApiDocument {
    return { openapi: '3.0.1', info: { title: 'Test API', version: '1' }, paths };
}

function standard(): ApiDocument {
    return {
        ...fixture({
            [`${PREFIX}/sites/{siteId}/clients`]: {
                parameters: [{ name: 'siteId', in: 'path', required: true, schema: { type: 'string' } }],
                get: {
                    operationId: 'listClients',
                    summary: 'List wireless clients',
                    tags: ['Client'],
                    description: 'Read active stations.<br/>No mutations.',
                    parameters: [
                        { $ref: '#/components/parameters/Page' },
                        { name: 'siteId', in: 'path', required: true, schema: { type: 'string', minLength: 3 } },
                    ],
                    responses: { 200: { $ref: '#/components/responses/Clients' } },
                },
            },
            [`${PREFIX}/sites/{siteId}/clients/{clientMac}/name`]: {
                patch: {
                    operationId: 'updateClientName',
                    summary: 'Update client name',
                    tags: ['Client'],
                    requestBody: { $ref: '#/components/requestBodies/Name' },
                },
            },
        }),
        components: {
            parameters: { Page: { name: 'page', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } } },
            requestBodies: { Name: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Name' } } } } },
            responses: { Clients: { content: { '*/*': { schema: { type: 'array', items: { $ref: '#/components/schemas/Name' } } } } } },
            schemas: { Name: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 128 } } } },
        },
    };
}

describe('OperationCatalog', () => {
    it('indexes the real bundled document without silently dropping operations', () => {
        const document = JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8')) as ApiDocument;
        const catalog = new OperationCatalog(document, 'bundled');
        expect(catalog.operations.length).toBe(1676);
        expect(new Set(catalog.operations.map((operation) => operation.operationId.toLowerCase())).size).toBe(1676);
        expect(catalog.search({ query: 'wifi summary' }).operations.some((operation) => operation.path.endsWith('/dashboard/wifi-summary'))).toBe(
            true
        );
        expect(catalog.describe('getWifiSummary').parameters.map((parameter) => parameter.name)).toEqual(
            expect.arrayContaining(['omadacId', 'siteId', 'start', 'end'])
        );
        const msp = catalog.operations.filter((operation) => operation.path.startsWith('/openapi/v1/msp/'));
        expect(msp).toHaveLength(118);
        expect(msp.every((operation) => operation.unsupportedReason?.includes('controller-scoped'))).toBe(true);
    });

    it('records source, load time and explicit fallback provenance', () => {
        const catalog = new OperationCatalog(standard(), 'bundled', 'Controller specification unavailable');
        expect(catalog.search()).toMatchObject({
            source: 'bundled',
            loadedAt: expect.any(Number),
            fallbackReason: 'Controller specification unavailable',
        });
        expect(catalog.describe('listClients')).toMatchObject({ source: 'bundled', fallbackReason: 'Controller specification unavailable' });
        expect(catalog.document).toEqual(standard());
    });

    it('resolves component metadata, overrides shared parameters and infers omitted path parameters', () => {
        const catalog = new OperationCatalog(standard(), 'live');
        const list = catalog.get(' LISTCLIENTS ');
        expect(list?.parameters.filter((parameter) => parameter.name === 'siteId')).toEqual([
            { name: 'siteId', in: 'path', required: true, schema: { type: 'string', minLength: 3 } },
        ]);
        expect(list?.parameters).toContainEqual({ name: 'page', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } });
        expect(list?.parameters).toContainEqual({ name: 'omadacId', in: 'path', required: true, schema: { type: 'string' } });
        const write = catalog.get('updateClientName');
        expect(write?.parameters.map((parameter) => parameter.name)).toEqual(['omadacId', 'siteId', 'clientMac']);
        expect(write?.requestBody).toEqual({ required: true, contentType: 'application/json', schema: { $ref: '#/components/schemas/Name' } });
        const description = catalog.describe('updateClientName');
        expect(description.requestBody?.schema).toEqual({
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string', maxLength: 128 } },
        });
        expect(description.schemaResolution).toEqual({ complete: true, warnings: [] });
        expect(catalog.describe('listClients').responseSchema).toEqual({
            type: 'array',
            items: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 128 } } },
        });
        expect(catalog.describe('listClients').responseContentType).toBe('*/*');
        expect(list?.description).toBe('Read active stations.\nNo mutations.');
    });

    it('uses decoded local JSON pointer segments without following inherited keys', () => {
        const document = standard();
        const components = document.components as ApiDocument;
        components.schemas = { 'name/~schema': { type: 'string' } };
        components.requestBodies = { Name: { content: { 'application/json': { schema: { $ref: '#/components/schemas/name~1~0schema' } } } } };
        const catalog = new OperationCatalog(document, 'live');
        expect(catalog.describe('updateClientName').requestBody?.schema).toEqual({ type: 'string' });
    });

    it('keeps duplicate IDs stable across path ordering and rejects ambiguous bare IDs', () => {
        const paths = {
            [`${PREFIX}/one`]: { get: { operationId: 'duplicate' } },
            [`${PREFIX}/two`]: { post: { operationId: 'Duplicate' } },
        };
        const first = new OperationCatalog(fixture(paths), 'live');
        const second = new OperationCatalog(fixture(Object.fromEntries(Object.entries(paths).reverse())), 'live');
        expect(first.get('duplicate')).toBeUndefined();
        expect(first.operations.map((operation) => operation.operationId).sort()).toEqual(
            second.operations.map((operation) => operation.operationId).sort()
        );
        expect(first.operations[0].operationId).toMatch(/^duplicate__get_[a-f\d]{12}$/);
        for (const operation of first.operations) expect(first.get(operation.operationId)).toBe(operation);
        expect(() => first.describe('duplicate')).toThrow('Unknown API operation');
    });

    it('generates stable IDs when the specification omitted them', () => {
        const catalog = new OperationCatalog(fixture({ [`${PREFIX}/one`]: { get: {} } }), 'live');
        expect(catalog.operations[0].operationId).toMatch(/^get_[a-f\d]{12}$/);
    });

    it('searches IDs, summaries, tags and descriptions while enforcing method/profile filters', () => {
        const catalog = new OperationCatalog(standard(), 'live');
        expect(catalog.search({ query: 'wireless clients' })).toMatchObject({ total: 1, operations: [{ operationId: 'listClients' }] });
        expect(catalog.search({ query: 'stations' }).operations.map((operation) => operation.operationId)).toEqual([
            'listClients',
            'updateClientName',
        ]);
        expect(catalog.search({ query: 'updateClientName' }).operations[0].operationId).toBe('updateClientName');
        expect(catalog.search({ tag: 'CLI', method: 'patch' }).operations.map((operation) => operation.operationId)).toEqual(['updateClientName']);
        expect(catalog.search({ readOnly: true }).operations.map((operation) => operation.operationId)).toEqual(['listClients']);
        expect(catalog.search({ readOnly: true, method: 'PATCH' }).total).toBe(0);
        expect(() => catalog.describe('updateClientName', { readOnly: true })).toThrow('read-only profile');
        expect(() => catalog.describe('missing')).toThrow('Unknown API operation');
    });

    it('bounds result counts and reports matching totals independently of the page size', () => {
        const catalog = new OperationCatalog(standard(), 'live');
        const result = catalog.search({ limit: 1 });
        expect(result.total).toBe(2);
        expect(result.operations).toHaveLength(1);
        expect(result.operations[0]).not.toHaveProperty('parameters');
    });

    it('matches common network vocabulary and camel-case keywords while preserving filters', () => {
        const catalog = new OperationCatalog(
            fixture({
                [`${PREFIX}/gateways/status`]: { get: { operationId: 'getGatewayWanStatus', summary: 'Gateway connection state' } },
                [`${PREFIX}/aps/reboot`]: { post: { operationId: 'rebootAp', summary: 'Reboot an AP' } },
                [`${PREFIX}/aps/health`]: { get: { operationId: 'getApHealth', summary: 'AP health' } },
            }),
            'live'
        );
        expect(catalog.search({ query: 'router status' }).operations.map((operation) => operation.operationId)).toEqual(['getGatewayWanStatus']);
        expect(catalog.search({ query: 'gatewayWanStatus' }).operations[0].operationId).toBe('getGatewayWanStatus');
        expect(catalog.search({ query: 'restart access point' }).operations.map((operation) => operation.operationId)).toEqual(['rebootAp']);
        expect(catalog.search({ query: 'restart access point', readOnly: true }).total).toBe(0);
        expect(catalog.search({ query: 'router unrecognizedword' }).total).toBe(0);
        expect(catalog.get('restart access point')).toBeUndefined();
        expect(new OperationCatalog(standard(), 'live').search({ query: 'wi-fi client' }).operations[0].operationId).toBe('listClients');
    });

    it('ranks exact operation identities above related descriptions', () => {
        const catalog = new OperationCatalog(
            fixture({
                [`${PREFIX}/one`]: { get: { operationId: 'getClientStatus', deprecated: true } },
                [`${PREFIX}/two`]: { get: { operationId: 'alternative', summary: 'getClientStatus', tags: ['getClientStatus'] } },
            }),
            'live'
        );
        expect(catalog.search({ query: 'getClientStatus' }).operations[0].operationId).toBe('getClientStatus');
    });

    it.each([0, 51, 1.5, Number.NaN])('rejects invalid search limit %s', (limit) => {
        expect(() => new OperationCatalog(standard(), 'live').search({ limit })).toThrow('Search limit');
    });

    it('rejects unsupported search methods and oversized search strings', () => {
        const catalog = new OperationCatalog(standard(), 'live');
        expect(() => catalog.search({ method: 'HEAD' })).toThrow('Unsupported search HTTP method');
        expect(() => catalog.search({ query: 'x'.repeat(257) })).toThrow('too long');
        expect(() => catalog.search({ tag: 'x'.repeat(129) })).toThrow('too long');
    });

    it.each([
        '/api/internal/settings',
        'https://controller.example.com/openapi/v1/{omadacId}/sites',
        `${PREFIX}/../settings`,
        `${PREFIX}/%2e%2e/settings`,
        `${PREFIX}/%2Fsettings`,
        `${PREFIX}/sites?next=/settings`,
        `${PREFIX}/sites#fragment`,
        `${PREFIX}//sites`,
        `${PREFIX}/sites\\settings`,
    ])('retains unsafe path as explicitly unsupported documentation: %s', (path) => {
        const catalog = new OperationCatalog(fixture({ [path]: { get: { operationId: 'unsafe' } } }), 'live');
        expect(catalog.get('unsafe')?.unsupportedReason).toBeTruthy();
        expect(catalog.search().operations[0].unsupportedReason).toBeTruthy();
    });

    it('rejects required cookie/header metadata and preserves optional metadata without accepting caller headers', () => {
        const catalog = new OperationCatalog(
            fixture({
                [`${PREFIX}/settings`]: {
                    get: {
                        operationId: 'headerOperation',
                        parameters: [
                            { name: 'X-Required', in: 'header', required: true, schema: { type: 'string' } },
                            { name: 'session', in: 'cookie', schema: { type: 'string' } },
                        ],
                    },
                },
            }),
            'live'
        );
        expect(catalog.get('headerOperation')?.unsupportedReason).toContain('Required header parameter');
        expect(catalog.get('headerOperation')?.parameters).toContainEqual({
            name: 'session',
            in: 'cookie',
            required: false,
            schema: { type: 'string' },
        });
    });

    it.each([
        { parameters: { wrong: true } },
        { parameters: [{ $ref: 'https://example.com/parameters.json' }] },
        { parameters: [{ $ref: '#/components/missing' }] },
        { parameters: [{ name: 'q', in: 'unknown', schema: { type: 'string' } }] },
        { parameters: [{ name: 'q', in: 'query' }] },
        { parameters: [{ name: 'q', in: 'query', required: 'true', schema: {} }] },
        { parameters: [{ name: 'q', in: 'query', schema: {}, content: {} }] },
        { requestBody: { content: {} } },
        { requestBody: { required: 'true', content: { 'application/json': { schema: {} } } } },
        { requestBody: { content: { 'application/json': {} } } },
        { requestBody: { $ref: '#/components/missing' } },
        { requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } } },
    ])('marks malformed or unsupported request metadata as non-executable: %j', (metadata) => {
        const catalog = new OperationCatalog(fixture({ [`${PREFIX}/one`]: { post: { operationId: 'unsupported', ...metadata } } }), 'live');
        expect(catalog.get('unsupported')?.unsupportedReason).toBeTruthy();
    });

    it('handles cyclic metadata references without dropping the operation', () => {
        const document = fixture({ [`${PREFIX}/one`]: { get: { operationId: 'cycle', parameters: [{ $ref: '#/components/parameters/Loop' }] } } });
        document.components = { parameters: { Loop: { $ref: '#/components/parameters/Loop' } } };
        expect(new OperationCatalog(document, 'live').get('cycle')?.unsupportedReason).toContain('cyclic');
    });

    it('retains cyclic and external schema references with explicit incomplete-description evidence', () => {
        const document = standard();
        (document.components as ApiDocument).schemas = {
            Name: {
                type: 'object',
                properties: { parent: { $ref: '#/components/schemas/Name' }, external: { $ref: 'https://example.com/schema.json' } },
            },
        };
        const description = new OperationCatalog(document, 'live').describe('updateClientName');
        expect(description.schemaResolution.complete).toBe(false);
        expect(description.schemaResolution.warnings.join(' ')).toMatch(/Cyclic.*Only local/);
        expect(JSON.stringify(description.requestBody?.schema)).toContain('x-discovery-unresolved');
    });

    it('bounds deep expansion without inventing a complete schema', () => {
        const document = standard();
        let nested: ApiDocument = { type: 'string' };
        for (let i = 0; i < 20; i++) nested = { type: 'object', properties: { child: nested } };
        (document.components as ApiDocument).schemas = { Name: nested };
        const description = new OperationCatalog(document, 'live').describe('updateClientName');
        expect(description.schemaResolution.complete).toBe(false);
        expect(JSON.stringify(description.requestBody?.schema)).toContain('x-discovery-truncated');
    });

    it('bounds wide and oversized schema descriptions across the entire operation', () => {
        const document = standard();
        (document.components as ApiDocument).schemas = {
            Name: {
                type: 'object',
                properties: Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`field${index}`, { type: 'string' }])),
            },
        };
        const description = new OperationCatalog(document, 'live').describe('updateClientName');
        expect(description.schemaResolution.complete).toBe(false);
        expect(Object.keys(description.requestBody?.schema.properties as ApiDocument).length).toBeLessThan(5_000);
        (document.components as ApiDocument).schemas = { Name: { type: 'string', description: 'x'.repeat(4_001) } };
        const long = new OperationCatalog(document, 'live').describe('updateClientName');
        expect(long.schemaResolution.complete).toBe(false);
        expect(long.requestBody?.schema.description).toEqual({ 'x-discovery-truncated': true });
    });

    it('reports unresolved response metadata separately from executable request metadata', () => {
        const document = fixture({
            [`${PREFIX}/one`]: { get: { operationId: 'one', responses: { 200: { $ref: 'https://example.com/response.json' } } } },
        });
        const catalog = new OperationCatalog(document, 'live');
        expect(catalog.get('one')?.unsupportedReason).toBeUndefined();
        expect(catalog.describe('one').schemaResolution).toEqual({ complete: false, warnings: ['Only local OpenAPI references are supported'] });
    });

    it('retains binary response media independently of format/schema availability', () => {
        const document = fixture({
            [`${PREFIX}/download`]: { get: { operationId: 'downloadFile', responses: { 200: { content: { 'application/octet-stream': {} } } } } },
        });
        const operation = new OperationCatalog(document, 'live').get('downloadFile');
        expect(operation?.responseContentType).toBe('application/octet-stream');
        expect(operation?.responseSchema).toBeUndefined();
    });

    it('rejects excessive path, operation-ID and parameter lengths', () => {
        expect(() => new OperationCatalog(fixture({ ['/' + 'x'.repeat(2_048)]: { get: {} } }), 'live')).toThrow('path exceeds');
        expect(() => new OperationCatalog(fixture({ [`${PREFIX}/one`]: { get: { operationId: 'x'.repeat(257) } } }), 'live')).toThrow(
            'operation ID exceeds'
        );
        expect(
            () => new OperationCatalog(fixture({ [`${PREFIX}/one`]: { get: { parameters: Array.from({ length: 201 }, () => ({})) } } }), 'live')
        ).toThrow('too many parameters');
    });

    it.each([
        {},
        { openapi: '2.0', paths: {} },
        { openapi: '3.0.1', paths: [] },
        { openapi: '3.0.1', paths: {} },
        fixture({ [`${PREFIX}/one`]: null }),
        fixture({ [`${PREFIX}/one`]: { get: null } }),
    ])('rejects invalid or empty documents instead of presenting a partial catalogue: %j', (document) => {
        expect(() => new OperationCatalog(document, 'live')).toThrow();
    });

    it('rejects oversized operation and path inventories', () => {
        const paths: ApiDocument = {};
        for (let index = 0; index <= 10_000; index++) paths[`${PREFIX}/${index}`] = {};
        expect(() => new OperationCatalog(fixture(paths), 'live')).toThrow('too many paths');
        const operations: ApiDocument = {};
        for (let index = 0; index <= 2_000; index++) operations[`${PREFIX}/${index}`] = { get: {}, post: {}, patch: {}, put: {}, delete: {} };
        expect(() => new OperationCatalog(fixture(operations), 'live')).toThrow('too many operations');
    });
});
