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

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe('catalogue refresh and diagnostics', () => {
    it('coalesces refreshes, serves the old immutable snapshot during refresh and replaces it atomically', async () => {
        const next = deferred<unknown>();
        const fetch = vi.fn().mockResolvedValueOnce(doc('original')).mockReturnValueOnce(next.promise);
        const loader = new CatalogLoader(fetch, 'live');
        const original = await loader.get();
        const refreshing = loader.refresh();
        expect(loader.refresh()).toBe(refreshing);
        expect(await loader.get()).toBe(original);
        expect(original.get('original')).toBeDefined();
        next.resolve(doc('updated'));
        const updated = await refreshing;
        expect(updated.get('updated')).toBeDefined();
        expect(await loader.get()).toBe(updated);
        expect(original.get('updated')).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('a late initial load cannot overwrite a newer successful refresh', async () => {
        const initial = deferred<unknown>();
        const next = deferred<unknown>();
        const fetch = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(next.promise);
        const loader = new CatalogLoader(fetch, 'live');
        const loading = loader.get();
        const refreshing = loader.refresh();
        next.resolve(doc('newer'));
        const newer = await refreshing;
        initial.resolve(doc('older'));
        expect((await loading).get('older')).toBeDefined();
        expect(await loader.get()).toBe(newer);
        expect(loader.peek()).toBe(newer);
    });

    it('a late failing initial load does not clear a successful refresh', async () => {
        const initial = deferred<unknown>();
        const fetch = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValueOnce(doc('newer')).mockRejectedValue(new Error('private'));
        const loader = new CatalogLoader(fetch, 'live');
        const loading = loader.get();
        const refreshed = await loader.refresh();
        initial.reject(new Error('private'));
        await expect(loading).rejects.toThrow('Live OpenAPI discovery failed');
        expect(await loader.get()).toBe(refreshed);
    });

    it('a first get joins an already requested refresh without making another load', async () => {
        const next = deferred<unknown>();
        const fetch = vi.fn().mockReturnValue(next.promise);
        const loader = new CatalogLoader(fetch, 'live');
        const refreshing = loader.refresh();
        expect(loader.get()).toBe(refreshing);
        next.resolve(doc());
        expect(await loader.get()).toBe(await refreshing);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('retains a valid snapshot after live-only refresh failure and permits another refresh', async () => {
        const fetch = vi.fn().mockResolvedValue(doc('original'));
        const loader = new CatalogLoader(fetch, 'live');
        const original = await loader.get();
        fetch.mockRejectedValue({ response: { status: 403, data: { password: 'private' } } });
        await expect(loader.refresh()).rejects.toMatchObject({
            diagnostics: {
                attempts: expect.arrayContaining([expect.objectContaining({ status: 'failed', reason: 'http_error', httpStatus: 403 })]),
            },
        });
        expect(await loader.get()).toBe(original);
        fetch.mockResolvedValue(doc('recovered'));
        expect((await loader.refresh()).get('recovered')).toBeDefined();
    });

    it.each([
        [{ response: { status: 404, data: 'password=private' }, message: 'https://private.invalid/?token=private' }, 'http_error', 404],
        [{ code: 'ETIMEDOUT', message: 'private hostname' }, 'timeout', undefined],
        [{ code: 'ECONNABORTED', message: 'private hostname' }, 'timeout', undefined],
        [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'private certificate' }, 'tls_error', undefined],
        [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'private hostname' }, 'tls_error', undefined],
        [{ code: 'ECONNREFUSED', message: 'private hostname' }, 'connection_error', undefined],
        [new Error('private controller response'), 'request_failed', undefined],
    ] as const)('classifies bounded request evidence without returning private exception details', async (error, reason, httpStatus) => {
        const loader = new CatalogLoader(vi.fn().mockRejectedValue(error), 'auto', async () => doc());
        const catalog = await loader.get();
        const report = loader.diagnostics(catalog)!;
        expect(report.attempts).toHaveLength(3);
        expect(report.attempts.map((attempt) => attempt.stage)).toEqual(['combined', 'configuration', 'default']);
        expect(report.attempts.every((attempt) => attempt.reason === reason && attempt.httpStatus === httpStatus)).toBe(true);
        expect(JSON.stringify(report)).not.toMatch(/private|password|token|https:/);
        report.attempts.length = 0;
        expect(loader.diagnostics(catalog)?.attempts).toHaveLength(3);
    });

    it.each([
        ['<html>private login page</html>', 'unexpected_content'],
        [{ openapi: '3.2.0', paths: {}, private: 'private' }, 'invalid_document'],
        [{ openapi: '3.0.1', paths: {}, private: 'x'.repeat(16 * 1024 * 1024) }, 'document_too_large'],
    ] as const)('distinguishes invalid documents from failed HTTP requests', async (value, reason) => {
        const loader = new CatalogLoader(vi.fn().mockResolvedValue(value), 'auto', async () => doc());
        const report = loader.diagnostics(await loader.get());
        expect(report?.attempts[0]).toEqual({ stage: 'combined', status: 'failed', reason });
        expect(report?.attempts.at(-1)).toEqual({ stage: 'default', status: 'failed', reason });
    });

    it('discloses assembly conflicts after successful group reads', async () => {
        const fetch = vi.fn(async (path: string) => {
            await Promise.resolve();
            if (path.endsWith('00%20All')) throw { response: { status: 404 } };
            if (path.endsWith('swagger-config')) return { urls: [{ url: 'first' }, { url: 'second' }] };
            return doc(path.endsWith('first') ? 'first' : 'conflicting');
        });
        const loader = new CatalogLoader(fetch, 'auto', async () => doc());
        expect(loader.diagnostics(await loader.get())?.attempts).toContainEqual({ stage: 'group', status: 'failed', reason: 'group_conflict' });
    });

    it('bounds advertised group loading before any group requests', async () => {
        const fetch = vi.fn(async (path: string) => {
            await Promise.resolve();
            if (path.endsWith('00%20All')) throw new Error('not found');
            return { urls: Array.from({ length: 33 }, (_, i) => ({ name: `private-${i}`, url: `group-${i}` })) };
        });
        const loader = new CatalogLoader(fetch, 'auto', async () => doc());
        const report = loader.diagnostics(await loader.get());
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(report?.attempts).toContainEqual({ stage: 'configuration', status: 'failed', reason: 'too_many_groups' });
        expect(JSON.stringify(report)).not.toContain('private');
    });

    it('reports bundled-only mode without fetching live documents', async () => {
        const fetch = vi.fn();
        const loader = new CatalogLoader(fetch, 'bundled', async () => doc());
        const first = await loader.get();
        const fresh = await loader.refresh();
        expect(fresh).not.toBe(first);
        expect(loader.diagnostics(fresh)).toMatchObject({ mode: 'bundled', attempts: [] });
        expect(fetch).not.toHaveBeenCalled();
    });
});
