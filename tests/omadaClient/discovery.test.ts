import type { AxiosInstance } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { CatalogLoader } from '../../src/discovery/load.js';
import { DiscoveryOperations } from '../../src/omadaClient/discovery.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';

const document = {
    openapi: '3.0.1',
    paths: {
        '/openapi/v1/{omadacId}/sites': {
            get: { operationId: 'sites', summary: 'List sites', responses: {} },
            post: { operationId: 'createSite', summary: 'Create site', responses: {} },
        },
    },
};
function setup(readOnly = false, injectLoader = true) {
    const http = { get: vi.fn().mockResolvedValue({ data: document }) };
    const request = { request: vi.fn().mockResolvedValue({ errorCode: 0, result: [] }), ensureSuccess: vi.fn((response) => response.result) };
    const fetch = vi.fn().mockResolvedValue(document);
    const service = new DiscoveryOperations(
        request as unknown as RequestHandler,
        http as unknown as AxiosInstance,
        { omadacId: 'controller', toolProfile: readOnly ? 'read-only' : 'full' },
        injectLoader ? new CatalogLoader(fetch, 'auto') : undefined
    );
    return { service, request, http, fetch };
}
describe('discovery client policy and loading', () => {
    it('loads lazily without changing startup and caches one catalogue across methods', async () => {
        const { service, request, http, fetch } = setup();
        expect(fetch).not.toHaveBeenCalled();
        const results = await Promise.all([service.searchApiOperations(), service.describeApiOperation('sites'), service.getCatalog()]);
        expect(results).toHaveLength(3);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(http.get).not.toHaveBeenCalled();
        expect(request.request).not.toHaveBeenCalled();
    });
    it('uses only bounded controller documentation GETs and never sends auth headers', async () => {
        const { service, http } = setup(false, false);
        await service.searchApiOperations();
        expect(http.get).toHaveBeenCalledWith('/v3/api-docs/00%20All', {
            maxRedirects: 0,
            maxContentLength: 16 * 1024 * 1024,
            timeout: 10000,
        });
    });
    it('enforces server-provided read-only policy over a full-access client', async () => {
        const { service, request } = setup();
        const result = (await service.searchApiOperations({}, { readOnly: true })) as { operations: { method: string }[] };
        expect(result.operations.every((op) => op.method === 'GET')).toBe(true);
        await expect(service.searchApiOperations({ method: 'POST' }, { readOnly: true })).rejects.toThrow('Read-only');
        await expect(service.describeApiOperation('createSite', { readOnly: true })).rejects.toThrow('read-only');
        await expect(service.executeApiOperation({ operationId: 'createSite', dryRun: false }, { readOnly: true })).rejects.toThrow('Read-only');
        expect(request.request).not.toHaveBeenCalled();
    });
    it('cannot weaken a client-configured read-only policy with an explicit full policy', async () => {
        const { service, request } = setup(true);
        await expect(service.executeApiOperation({ operationId: 'createSite', dryRun: false }, { readOnly: false })).rejects.toThrow('Read-only');
        const result = await service.executeApiOperation({ operationId: 'sites' }, { readOnly: false });
        expect(result).toMatchObject({ written: false, result: [] });
        expect(request.request).toHaveBeenCalledTimes(1);
    });
});

it('returns sanitized source diagnostics from search, describe and refresh', async () => {
    const { service } = setup();
    expect(await service.searchApiOperations()).toMatchObject({
        discoveryDiagnostics: { mode: 'auto', attempts: [{ stage: 'combined', status: 'ok' }] },
    });
    expect(await service.describeApiOperation('sites')).toMatchObject({ discoveryDiagnostics: { attempts: [{ stage: 'combined', status: 'ok' }] } });
    expect(await service.refreshApiCatalog()).toMatchObject({
        status: 'refreshed',
        current: { source: 'live', schemaVersion: '3.0.1', operations: 2, documentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        previous: { source: 'live' },
        changed: false,
    });
});

it('retains prior live catalogue and safe evidence when an explicit live refresh fails', async () => {
    const fetch = vi.fn().mockResolvedValue(document);
    const loader = new CatalogLoader(fetch, 'live');
    const service = new DiscoveryOperations({} as RequestHandler, {} as AxiosInstance, { omadacId: 'controller' }, loader);
    const original = await service.getCatalog();
    fetch.mockRejectedValue({ code: 'ETIMEDOUT', message: 'private controller secret' });
    const refreshed = await service.refreshApiCatalog();
    expect(refreshed).toMatchObject({ status: 'failed', cacheRetained: true, current: { source: 'live' } });
    expect(JSON.stringify(refreshed)).not.toContain('private');
    expect(await service.getCatalog()).toBe(original);
});

it('does not expose local bundle failure messages and reports whether a cache exists', async () => {
    const loader = new CatalogLoader(vi.fn(), 'bundled', () => Promise.reject(new Error('/private/config/secret')));
    const service = new DiscoveryOperations({} as RequestHandler, {} as AxiosInstance, { omadacId: 'controller' }, loader);
    expect(await service.refreshApiCatalog()).toEqual({ status: 'failed', cacheRetained: false, reason: 'catalogue_load_failed' });
});
