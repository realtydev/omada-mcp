import { describe, expect, it, vi } from 'vitest';
import { CatalogLoader, documentationPath, loadBundledApiDocument } from '../../src/discovery/load.js';

const doc = (id = 'listSites') => ({ openapi: '3.0.1', paths: { '/openapi/v1/{omadacId}/sites': { get: { operationId: id, responses: {} } } } });

describe('controller specification loading', () => {
    it('merges distinct verbs of a shared path without losing operations', async () => {
        const first = doc('first');
        const second = { openapi: '3.0.1', paths: { '/openapi/v1/{omadacId}/sites': { patch: { operationId: 'second', responses: {} } } } };
        const fetch = vi.fn((path: string): Promise<unknown> => {
            if (path.endsWith('00%20All')) return Promise.reject(new Error('404'));
            if (path.endsWith('swagger-config')) return Promise.resolve({ urls: [{ url: 'a' }, { url: 'b' }] });
            return Promise.resolve(path.endsWith('/a') ? first : second);
        });
        const catalogue = await new CatalogLoader(fetch, 'live').get();
        expect(catalogue.operations.map((op) => op.operationId)).toEqual(['first', 'second']);
    });
    it.each(['schema', 'verb'])('rejects conflicting group %s definitions rather than silently replacing them', async (kind) => {
        const first = { ...doc(), components: { schemas: { Body: { type: 'object', required: ['first'] } } } };
        const second =
            kind === 'schema'
                ? { openapi: '3.0.1', paths: {}, components: { schemas: { Body: { type: 'object', required: ['second'] } } } }
                : doc('conflicting');
        const fetch = vi.fn((path: string): Promise<unknown> => {
            if (path.endsWith('00%20All')) return Promise.reject(new Error('404'));
            if (path.endsWith('swagger-config')) return Promise.resolve({ urls: [{ url: 'a' }, { url: 'b' }] });
            return Promise.resolve(path.endsWith('/a') ? first : second);
        });
        await expect(new CatalogLoader(fetch, 'live').get()).rejects.toThrow('Live OpenAPI discovery failed');
        expect((await new CatalogLoader(fetch, 'auto', async () => doc('fallback')).get()).source).toBe('bundled');
    });
    it('loads a single live snapshot shared by concurrent requests', async () => {
        const fetch = vi.fn().mockResolvedValue(doc());
        const bundled = vi.fn();
        const loader = new CatalogLoader(fetch, 'auto', bundled);
        const results = await Promise.all([loader.get(), loader.get(), loader.get()]);
        expect(results[0]).toBe(results[1]);
        expect(results[1]).toBe(results[2]);
        expect(results[0].source).toBe('live');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(bundled).not.toHaveBeenCalled();
    });
    it('loads every advertised relative documentation group', async () => {
        const fetch = vi.fn(async (path: string) => {
            await Promise.resolve();
            if (path.endsWith('00%20All')) throw new Error('404');
            if (path.endsWith('swagger-config'))
                return {
                    urls: [
                        { name: 'Site', url: '02 Sites' },
                        { name: 'Client', url: '/v3/api-docs/05 Client' },
                    ],
                };
            if (path.endsWith('02%20Sites')) return doc();
            return { openapi: '3.0.1', paths: { '/openapi/v1/{omadacId}/clients': { get: { operationId: 'clients', responses: {} } } } };
        });
        const catalogue = await new CatalogLoader(fetch, 'live').get();
        expect(catalogue.operations).toHaveLength(2);
        expect(fetch.mock.calls.map(([path]) => path)).toContain('/v3/api-docs/05%20Client');
    });
    it('reports bundled fallback instead of returning an incomplete live catalogue', async () => {
        const fetch = vi.fn(async (path: string) => {
            await Promise.resolve();
            if (path.endsWith('swagger-config'))
                return {
                    urls: [
                        { name: 'Site', url: 'sites' },
                        { name: 'Client', url: 'clients' },
                    ],
                };
            if (path.endsWith('/sites')) return doc();
            throw new Error('controller secret response');
        });
        const catalogue = await new CatalogLoader(fetch, 'auto', async () => doc('bundled')).get();
        expect(catalogue.source).toBe('bundled');
        expect(catalogue.fallbackReason).toBeTruthy();
        expect(catalogue.fallbackReason).not.toContain('secret');
        expect(catalogue.get('bundled')).toBeDefined();
    });
    it('fails in live-only mode and permits a later retry', async () => {
        const fetch = vi.fn().mockRejectedValue(new Error('unavailable'));
        const loader = new CatalogLoader(fetch, 'live', vi.fn());
        await expect(loader.get()).rejects.toThrow('Live OpenAPI discovery failed');
        fetch.mockResolvedValue(doc());
        expect((await loader.get()).source).toBe('live');
    });
    it('bundled mode performs no network requests and ships a usable snapshot', async () => {
        const fetch = vi.fn();
        const catalogue = await new CatalogLoader(fetch, 'bundled').get();
        expect(catalogue.source).toBe('bundled');
        expect(catalogue.operations.length).toBeGreaterThan(1000);
        expect(fetch).not.toHaveBeenCalled();
        expect((await loadBundledApiDocument()).openapi).toBe('3.0.1');
    });
    it.each([
        'https://evil.invalid/v3/api-docs',
        '//evil.invalid/v3/api-docs',
        '/v3/api-docs/../../openapi',
        '/v3/api-docs/%2e%2e/secret',
        '/v3/api-docs/%5csecret',
        '/v3/api-docs/x?url=https://evil.invalid',
        '/v3/api-docs/x#fragment',
        '/openapi/secret',
        '/v3/api-docs/\nsecret',
    ])('rejects unsafe advertised URL %j', async (url) => {
        expect(() => documentationPath(url)).toThrow('Invalid controller documentation path');
        const fetch = vi.fn(async (path: string) => {
            await Promise.resolve();
            if (path.endsWith('swagger-config')) return { urls: [{ name: 'All', url }] };
            throw new Error('404');
        });
        const catalogue = await new CatalogLoader(fetch, 'auto', async () => doc()).get();
        expect(catalogue.source).toBe('bundled');
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('rejects wrong-version, empty, and malformed live documents', async () => {
        for (const value of [{ openapi: '3.2.0', paths: {} }, 'html', { openapi: '3.0.1', paths: [] }]) {
            const catalogue = await new CatalogLoader(vi.fn().mockResolvedValue(value), 'auto', async () => doc()).get();
            expect(catalogue.source).toBe('bundled');
        }
    });
});

it('loads OpenAPI 3.1 and rejects mixed-dialect grouped documents', async () => {
    const live = { openapi: '3.1.0', paths: { '/openapi/v1/{omadacId}/sites': { get: { operationId: 'sites' } } } };
    expect((await new CatalogLoader(vi.fn().mockResolvedValue(live), 'live').get()).document.openapi).toBe('3.1.0');
    const fetch = vi.fn((path: string): Promise<unknown> => {
        if (path.endsWith('00%20All')) return Promise.reject(new Error('404'));
        if (path.endsWith('swagger-config')) return Promise.resolve({ urls: [{ url: 'a' }, { url: 'b' }] });
        return Promise.resolve(path.endsWith('/a') ? live : doc('other'));
    });
    await expect(new CatalogLoader(fetch, 'live').get()).rejects.toThrow('Live OpenAPI discovery failed');
});
