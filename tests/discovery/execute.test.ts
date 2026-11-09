import { describe, expect, it, vi } from 'vitest';

import { OperationCatalog } from '../../src/discovery/catalog.js';
import { type ExecuteApiOperationOptions, executeDiscoveredOperation } from '../../src/discovery/execute.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';

const BASE = '/openapi/v1/{omadacId}/sites/{siteId}';
const context = { omadacId: 'controller-1', siteId: 'site-1', readOnly: false };
const parameter = (name: string, schema: Record<string, unknown> = { type: 'string' }, required = false, location = 'query') => ({
    name,
    in: location,
    schema,
    required,
});

function setup(overrides: Record<string, unknown> = {}, schema: Record<string, unknown> = {}) {
    const operation = {
        operationId: 'listThings',
        parameters: [parameter('omadacId', { type: 'string' }, true, 'path'), parameter('siteId', { type: 'string' }, true, 'path')],
        ...overrides,
    };
    const catalog = new OperationCatalog(
        {
            openapi: '3.0.1',
            paths: { [`${BASE}/things`]: { get: operation } },
            components: { schemas: schema },
        },
        'live'
    );
    const request = {
        request: vi.fn().mockResolvedValue({ errorCode: 0, result: { data: [] } }),
        ensureSuccess: vi.fn((response) => {
            if (response.errorCode !== 0) throw new Error(`Omada API errorCode: ${response.errorCode} - ${response.msg}`);
            return response.result;
        }),
    };
    const run = (options: Partial<ExecuteApiOperationOptions> = {}, policy = context) =>
        executeDiscoveredOperation(catalog, request as unknown as RequestHandler, { operationId: 'listThings', ...options }, policy);
    return { catalog, request, run };
}

function writeSetup(
    bodySchema: Record<string, unknown> = { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
    path = `${BASE}/things`,
    contentType = 'application/json',
    method: 'patch' | 'put' | 'delete' = 'patch'
) {
    const catalog = new OperationCatalog(
        {
            openapi: '3.0.1',
            paths: {
                [path]: {
                    [method]: { operationId: 'modifyThing', requestBody: { required: true, content: { [contentType]: { schema: bodySchema } } } },
                },
            },
            components: { schemas: {} },
        },
        'bundled'
    );
    const request = {
        request: vi.fn().mockResolvedValue({ errorCode: 0, result: { accepted: true } }),
        ensureSuccess: vi.fn((response) => {
            if (response.errorCode !== 0) throw new Error(`Omada errorCode: ${response.errorCode} - ${response.msg}`);
            return response.result;
        }),
    };
    const run = (options: Partial<ExecuteApiOperationOptions> = {}, policy = context) =>
        executeDiscoveredOperation(
            catalog,
            request as unknown as RequestHandler,
            { operationId: 'modifyThing', body: { enabled: true }, ...options },
            policy
        );
    return { catalog, request, run };
}

describe('discovered operation execution', () => {
    it('fills configured identifiers, executes a declared GET and preserves metadata', async () => {
        const { request, run } = setup();
        const response = await run();
        expect(request.request).toHaveBeenCalledExactlyOnceWith({
            method: 'GET',
            url: '/openapi/v1/controller-1/sites/site-1/things',
            params: {},
            paramsSerializer: { indexes: null },
            maxContentLength: 8 * 1024 * 1024,
            maxBodyLength: 1024 * 1024,
        });
        expect(response).toMatchObject({
            operationId: 'listThings',
            source: 'live',
            written: false,
            dryRun: false,
            verified: false,
            result: { data: [] },
        });
    });

    it('provides bounded required pagination defaults without claiming to fetch all pages', async () => {
        const { request, run } = setup({
            parameters: [
                parameter('omadacId', { type: 'string' }, true, 'path'),
                parameter('siteId', { type: 'string' }, true, 'path'),
                parameter('page', { type: 'integer', minimum: 1 }, true),
                parameter('pageSize', { type: 'integer', minimum: 1, maximum: 25 }, true),
            ],
        });
        await run();
        expect(request.request.mock.calls[0][0].params).toEqual({ page: 1, pageSize: 25 });
    });

    it('validates required values and rejects undeclared parameters before I/O', async () => {
        const { run, request } = setup({
            parameters: [
                parameter('omadacId', { type: 'string' }, true, 'path'),
                parameter('siteId', { type: 'string' }, true, 'path'),
                parameter('mode', { type: 'string', enum: ['a', 'b'] }, true),
            ],
        });
        for (const params of [{}, { mode: 1 }, { mode: 'c' }, { mode: 'a', random: 'bad' }]) await expect(run({ params })).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });

    it.each(['omadacId', 'mspId'])('does not permit overriding configured %s', async (name) => {
        const { request, run } = setup();
        await expect(run({ params: { [name]: 'another-controller' } })).rejects.toThrow('cannot be overridden');
        expect(request.request).not.toHaveBeenCalled();
    });

    it.each(['.', '..', '../other', 'x/y', 'x\\y', '%2fother', '%252e%252e', '?host=other', '#fragment', '\n'])(
        'rejects unsafe path values %j',
        async (siteId) => {
            const { request, run } = setup();
            await expect(run({ params: { siteId } })).rejects.toThrow();
            expect(request.request).not.toHaveBeenCalled();
        }
    );

    it('encodes valid path identifiers', async () => {
        const { request, run } = setup();
        await run({ params: { siteId: 'site with space' } });
        expect(request.request.mock.calls[0][0].url).toContain('site%20with%20space');
    });

    it('requires explicit write execution and never sends a default preview', async () => {
        const { request, run } = writeSetup();
        expect(await run()).toMatchObject({ dryRun: true, written: false, verified: false, request: { body: { enabled: true } } });
        expect(request.request).not.toHaveBeenCalled();
        const response = await run({ dryRun: false });
        expect(request.request).toHaveBeenCalledTimes(1);
        expect(response).toMatchObject({ dryRun: false, written: true, verified: false, result: { accepted: true } });
        expect(response.request).not.toHaveProperty('body');
        expect(response.warning).toContain('does not perform read-back verification');
    });

    it.each([true, false])('enforces read-only policy even for mutation preview dryRun=%s', async (dryRun) => {
        const { request, run } = writeSetup();
        await expect(run({ dryRun }, { ...context, readOnly: true })).rejects.toThrow('Read-only');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('validates body types, required properties and unknown fields before previews', async () => {
        const { request, run } = writeSetup();
        for (const body of [{ enabled: 'true' }, {}, undefined, { enabled: true, unknown: 1 }]) await expect(run({ body })).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });

    it('validates local references, nullable values and composed schemas without coercion', async () => {
        const { catalog, request } = writeSetup({
            allOf: [{ $ref: '#/components/schemas/Toggle' }, { type: 'object', properties: { name: { type: 'string', nullable: true } } }],
        });
        (catalog.document.components as { schemas: Record<string, unknown> }).schemas.Toggle = {
            type: 'object',
            required: ['enabled'],
            properties: { enabled: { type: 'boolean' } },
        };
        const response = await executeDiscoveredOperation(
            catalog,
            request as unknown as RequestHandler,
            { operationId: 'modifyThing', body: { enabled: true, name: null } },
            context
        );
        expect(response.dryRun).toBe(true);
        await expect(
            executeDiscoveredOperation(
                catalog,
                request as unknown as RequestHandler,
                { operationId: 'modifyThing', body: { enabled: 'true' } },
                context
            )
        ).rejects.toThrow('Invalid operation input');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('never resolves external schema references', async () => {
        const { request, run } = writeSetup({ $ref: 'https://attacker.invalid/schema' });
        await expect(run({ dryRun: false })).rejects.toThrow('local');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('fails closed on a newer JSON Schema dialect rather than ignoring its constraints', async () => {
        const { catalog, request, run } = setup();
        catalog.document.openapi = '3.1.0';
        await expect(run()).rejects.toThrow('OpenAPI 3.0 schema semantics');
        expect(request.request).not.toHaveBeenCalled();
    });

    it.each(['multipart/form-data', 'application/octet-stream', 'application/x-www-form-urlencoded'])(
        'refuses unsupported body media %s before writes',
        async (contentType) => {
            const { request, run } = writeSetup({}, `${BASE}/things`, contentType);
            await expect(run({ dryRun: false })).rejects.toThrow(/multipart|content|JSON|unsupported/);
            expect(request.request).not.toHaveBeenCalled();
        }
    );

    it('refuses a raw body for GET and unknown operation IDs', async () => {
        const { request, run } = setup();
        await expect(run({ body: {} })).rejects.toThrow('GET');
        await expect(run({ operationId: 'noSuchOperation' })).rejects.toThrow('Unknown');
        expect(request.request).not.toHaveBeenCalled();
    });

    it.each([
        '/openapi/v1/{omadacId}/../authorize',
        'https://attacker.invalid/openapi/v1/{omadacId}/things',
        '/api/internal',
        '/openapi/v1/{omadacId}//things',
        '/openapi/v1/{omadacId}/%2e%2e/things',
    ])('refuses unsafe declared paths %s', async (path) => {
        const { request, run } = writeSetup(undefined, path);
        await expect(run({ dryRun: false })).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });

    it('does not accept custom authentication/header parameters', async () => {
        const { request, run } = setup({
            parameters: [
                parameter('omadacId', { type: 'string' }, true, 'path'),
                parameter('siteId', { type: 'string' }, true, 'path'),
                parameter('Authorization', { type: 'string' }, false, 'header'),
            ],
        });
        await expect(run({ params: { Authorization: 'stolen' } })).rejects.toThrow('Unknown operation parameter');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('serializes scalar arrays and documented Spring objects without stringifying objects', async () => {
        const { request, run } = setup({
            parameters: [
                parameter('omadacId', { type: 'string' }, true, 'path'),
                parameter('siteId', { type: 'string' }, true, 'path'),
                parameter('ids', { type: 'array', items: { type: 'integer' } }),
                parameter('arg4', {
                    type: 'object',
                    properties: { enabled: { type: 'boolean' }, filters: { type: 'object', properties: { limit: { type: 'integer' } } } },
                }),
            ],
        });
        await run({ params: { ids: [1, 2], arg4: { enabled: false, filters: { limit: 3 } } } });
        expect(request.request.mock.calls[0][0].params).toEqual({ ids: [1, 2], enabled: false, 'filters.limit': 3 });
        await expect(run({ params: { arg4: { bad: 'value' } } })).rejects.toThrow('undocumented');
    });

    it('rejects colliding object/query fields rather than silently replacing them', async () => {
        const { request, run } = setup({
            parameters: [
                parameter('omadacId', { type: 'string' }, true, 'path'),
                parameter('siteId', { type: 'string' }, true, 'path'),
                parameter('page', { type: 'integer' }),
                parameter('arg4', { type: 'object', properties: { page: { type: 'integer' } } }),
            ],
        });
        await expect(run({ params: { page: 1, arg4: { page: 2 } } })).rejects.toThrow('collides');
        expect(request.request).not.toHaveBeenCalled();
    });

    it.each([`${BASE}/aps/{apMac}/radio-config`, '/openapi/v2/{omadacId}/sites/{siteId}/site/log-notification'])(
        'retains dedicated write verification for %s',
        async (path) => {
            const { request, run } = writeSetup(undefined, path);
            const params = path.includes('{apMac}') ? { apMac: 'AA-BB-CC-DD-EE-FF' } : undefined;
            const preview = await run({ params });
            expect(preview.dryRun).toBe(true);
            expect(preview.warning).toMatch(/setApRadio|setLogNotifications/);
            await expect(run({ params, dryRun: false })).rejects.toThrow(/setApRadio|setLogNotifications/);
            expect(request.request).not.toHaveBeenCalled();
        }
    );

    it('preserves controller errors and warns about uncertain writes without replaying', async () => {
        const { request, run } = writeSetup();
        request.request.mockRejectedValue(new Error('PATCH /things (HTTP 403) (errorCode: -1) - Forbidden'));
        await expect(run({ dryRun: false })).rejects.toThrow('HTTP 403');
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('directs SSID writes to the preserving workflow while allowing discovery previews', async () => {
        const { request, run } = writeSetup(undefined, `${BASE}/wireless-network/wlans/{wlanId}/ssids/{ssidId}/update-basic-config`);
        const params = { wlanId: 'wlan-1', ssidId: 'ssid-1' };
        expect(await run({ params })).toMatchObject({ dryRun: true, written: false, warning: expect.stringContaining('updateSsid') });
        await expect(run({ params, dryRun: false })).rejects.toThrow('Use updateSsid');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('keeps site-template SSID writes available because the site tool cannot update templates', async () => {
        const { request, run } = writeSetup(
            undefined,
            '/openapi/v1/{omadacId}/sitetemplates/{siteTemplateId}/wireless-network/wlans/{wlanId}/ssids/{ssidId}/update-basic-config'
        );
        const params = { siteTemplateId: 'template-1', wlanId: 'wlan-1', ssidId: 'ssid-1' };
        expect(await run({ params, dryRun: false })).toMatchObject({ written: true, verified: false });
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['ports/{port}/profile', 'setSwitchPortProfile'],
        ['ports/{port}/poe-mode', 'setSwitchPortPoe'],
        ['ports/{port}/name', 'setSwitchPortName'],
        ['ports/{port}/status', 'setSwitchPortStatus'],
        ['ports/{port}/profile-override', 'setSwitchPortProfileOverride'],
        ['multi-ports/poe-mode', 'batchSetSwitchPortPoe'],
        ['multi-ports/name', 'batchSetSwitchPortName'],
        ['multi-ports/status', 'batchSetSwitchPortStatus'],
        ['multi-ports/profile-override', 'batchSetSwitchPortProfile'],
    ])('retains switch workflow safeguards for %s', async (suffix, tool) => {
        const { request, run } = writeSetup(undefined, `${BASE}/switches/{switchMac}/${suffix}`, 'application/json', 'put');
        const params = { switchMac: 'AA-BB-CC-DD-EE-FF', ...(suffix.includes('{port}') ? { port: '1' } : {}) };
        expect(await run({ params })).toMatchObject({ dryRun: true, written: false, warning: expect.stringContaining(tool) });
        await expect(run({ params, dryRun: false })).rejects.toThrow(`Use ${tool}`);
        expect(request.request).not.toHaveBeenCalled();
    });

    it('does not redirect switch template or unrelated verb operations to site-only setters', async () => {
        for (const [path, method] of [
            ['/openapi/v1/{omadacId}/sitetemplates/{siteTemplateId}/switches/{switchMac}/ports/{port}/name', 'put'],
            [`${BASE}/switches/{switchMac}/ports/{port}/name`, 'delete'],
        ] as const) {
            const { request, run } = writeSetup(undefined, path, 'application/json', method);
            const params = {
                switchMac: 'AA-BB-CC-DD-EE-FF',
                port: '1',
                ...(path.includes('{siteTemplateId}') ? { siteTemplateId: 'template' } : {}),
            };
            expect(await run({ params, dryRun: false })).toMatchObject({ written: true, verified: false });
            expect(request.request).toHaveBeenCalledTimes(1);
        }
    });

    it('does not accept malformed successful response envelopes', async () => {
        const { request, run } = setup();
        request.request.mockResolvedValue({ result: [] });
        await expect(run()).rejects.toThrow('invalid Open API response');
    });

    it('allows an explicit GET preview without reading the controller', async () => {
        const { request, run } = setup();
        expect(await run({ dryRun: true })).toMatchObject({ dryRun: true, written: false });
        expect(request.request).not.toHaveBeenCalled();
    });

    it('rejects binary request fields even under JSON media', async () => {
        const { request, run } = writeSetup({ type: 'string', format: 'binary' });
        await expect(run({ body: 'file', dryRun: false })).rejects.toThrow('Binary');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('sends the declared JSON media type rather than the shared transport default', async () => {
        const { request, run } = writeSetup(undefined, `${BASE}/things`, 'application/merge-patch+json');
        await run({ dryRun: false });
        expect(request.request.mock.calls[0][0]).toMatchObject({ headers: { 'Content-Type': 'application/merge-patch+json' } });
    });

    it('rejects binary downloads before reading the controller', async () => {
        const { request, run } = setup({
            responses: { '200': { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
        });
        await expect(run()).rejects.toThrow('Binary downloads');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('rejects octet-stream responses without relying on a binary schema format', async () => {
        const { request, run } = setup({ responses: { '200': { content: { 'application/octet-stream': { schema: { type: 'string' } } } } } });
        await expect(run()).rejects.toThrow('Only JSON responses');
        expect(request.request).not.toHaveBeenCalled();
    });

    it.each([
        ['POST', `${BASE}/setting/service/dhcp`, 'createDhcpReservation'],
        ['PATCH', `${BASE}/setting/service/dhcp/{mac}`, 'updateDhcpReservation'],
        ['DELETE', `${BASE}/setting/service/dhcp/{mac}`, 'deleteDhcpReservation'],
    ])('preserves dedicated DHCP safeguards for %s', async (method, path, preferred) => {
        const document = {
            openapi: '3.0.1',
            paths: { [path]: { [method.toLowerCase()]: { operationId: 'changeDhcp' } } },
        };
        const catalog = new OperationCatalog(document, 'live');
        const { request } = setup();
        const params = path.includes('{mac}') ? { mac: 'AA-BB-CC-DD-EE-FF' } : undefined;
        const options = { operationId: 'changeDhcp', params, dryRun: false };
        await expect(executeDiscoveredOperation(catalog, request as unknown as RequestHandler, options, context)).rejects.toThrow(preferred);
        expect(request.request).not.toHaveBeenCalled();
    });

    it('refuses unsupported path serialization instead of rendering a different path', async () => {
        const { request, run } = setup({
            parameters: [
                parameter('omadacId', { type: 'string' }, true, 'path'),
                { ...parameter('siteId', { type: 'string' }, true, 'path'), style: 'matrix' },
            ],
        });
        await expect(run()).rejects.toThrow('simple path');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('rejects oversized JSON inputs before previews and request validation', async () => {
        const { request, run } = writeSetup({ type: 'string' });
        await expect(run({ body: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow('1 MiB');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('serializes deepObject fields and non-exploded arrays explicitly', async () => {
        const { request, run } = setup({
            parameters: [
                parameter('omadacId', { type: 'string' }, true, 'path'),
                parameter('siteId', { type: 'string' }, true, 'path'),
                { ...parameter('filters', { type: 'object', properties: { active: { type: 'boolean' } } }), style: 'deepObject' },
                { ...parameter('ids', { type: 'array', items: { type: 'integer' } }), explode: false },
            ],
        });
        await run({ params: { filters: { active: true }, ids: [1, 2] } });
        expect(request.request.mock.calls[0][0].params).toEqual({ 'filters[active]': true, ids: '1,2' });
    });

    it('rejects null query values rather than silently dropping them', async () => {
        const { request, run } = setup({
            parameters: [
                parameter('omadacId', { type: 'string' }, true, 'path'),
                parameter('siteId', { type: 'string' }, true, 'path'),
                parameter('filter', { type: 'string', nullable: true }),
            ],
        });
        await expect(run({ params: { filter: null } })).rejects.toThrow('without losing');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('retains controller business errors and does not replay rejected writes', async () => {
        const { request, run } = writeSetup();
        request.request.mockResolvedValue({ errorCode: -1001, msg: 'Validation failed' } as never);
        await expect(run({ dryRun: false })).rejects.toThrow('errorCode: -1001');
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('rejects special property names and cycles before serialization', async () => {
        const { request, run } = writeSetup();
        await expect(run({ body: JSON.parse('{"enabled":true,"__proto__":{"bad":true}}') })).rejects.toThrow('unsupported property');
        const body: Record<string, unknown> = { enabled: true };
        body.self = body;
        await expect(run({ body })).rejects.toThrow('cycles');
        expect(request.request).not.toHaveBeenCalled();
    });
});
