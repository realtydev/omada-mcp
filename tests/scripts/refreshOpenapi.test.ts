import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compareSpecs, refreshOpenapi } from '../../scripts/refresh-openapi.mjs';

function document() {
    return {
        openapi: '3.0.1',
        info: { title: 'Omada', version: 'v0.1' },
        paths: {
            '/openapi/v1/{omadacId}/sites': {
                get: {
                    operationId: 'getSites',
                    responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Sites' } } } } },
                },
            },
        },
        components: {
            schemas: {
                Sites: { type: 'array', items: { $ref: '#/components/schemas/Site' } },
                Site: { type: 'object', properties: { name: { type: 'string' } } },
                Unused: { type: 'string' },
            },
        },
    };
}

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function files(next: unknown = document()) {
    const directory = await mkdtemp(join(tmpdir(), 'omada-spec-review-'));
    directories.push(directory);
    const source = join(directory, 'source.json');
    const target = join(directory, 'bundle.json');
    const original = `${JSON.stringify(document())}\n`;
    await writeFile(target, original);
    await writeFile(source, typeof next === 'string' ? next : JSON.stringify(next));
    return { source, target, original };
}

describe('OpenAPI snapshot review', () => {
    it('ignores object key order and leaves original bytes untouched even with --write', async () => {
        const current = document();
        const reordered = { components: current.components, paths: current.paths, info: { version: 'v0.1', title: 'Omada' }, openapi: '3.0.1' };
        const fixture = await files(reordered);
        const report = await refreshOpenapi({ ...fixture, write: true });
        expect(report).toMatchObject({ documentChanged: false, written: false, added: [], removed: [], changed: [] });
        expect(report.before.semanticSha256).toBe(report.after.semanticSha256);
        expect(report.before.sha256).not.toBe(report.after.sha256);
        expect(await readFile(fixture.target, 'utf8')).toBe(fixture.original);
    });

    it('reports transitive response schema edits even when operation IDs are unchanged', () => {
        const after = document();
        after.components.schemas.Site.properties.name.type = 'integer';
        expect(compareSpecs(document(), after)).toMatchObject({
            beforeOperations: 1,
            afterOperations: 1,
            changed: ['GET /openapi/v1/{omadacId}/sites'],
            added: [],
            removed: [],
        });
    });

    it('reports request-component edits and array order, but not unrelated component changes', () => {
        const before = document();
        const operation = before.paths['/openapi/v1/{omadacId}/sites'].get;
        Object.assign(operation, { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Site' } } } } });
        const after = structuredClone(before);
        Object.assign(after.components.schemas.Site.properties.name, { enum: ['first', 'second'] });
        expect(compareSpecs(before, after).changed).toHaveLength(1);
        const reordered = structuredClone(after);
        Object.assign(reordered.components.schemas.Site.properties.name, { enum: ['second', 'first'] });
        expect(compareSpecs(after, reordered).changed).toHaveLength(1);
        const unrelated = structuredClone(before);
        unrelated.components.schemas.Unused.type = 'integer';
        expect(compareSpecs(before, unrelated).changed).toEqual([]);
    });

    it('reports added and removed method/path pairs without changing the target by default', async () => {
        const next = document();
        const operation = next.paths['/openapi/v1/{omadacId}/sites'].get;
        Object.assign(next.paths, { '/openapi/v1/{omadacId}/devices': { get: operation } });
        delete next.paths['/openapi/v1/{omadacId}/sites'];
        const fixture = await files(next);
        const report = await refreshOpenapi(fixture);
        expect(report).toMatchObject({
            documentChanged: true,
            written: false,
            added: ['GET /openapi/v1/{omadacId}/devices'],
            removed: ['GET /openapi/v1/{omadacId}/sites'],
        });
        expect(await readFile(fixture.target, 'utf8')).toBe(fixture.original);
    });

    it('adopts a validated change only when write is explicit', async () => {
        const next = document();
        next.components.schemas.Site.properties.name.type = 'integer';
        const fixture = await files(next);
        const report = await refreshOpenapi({ ...fixture, write: true });
        expect(report.written).toBe(true);
        expect(JSON.parse(await readFile(fixture.target, 'utf8'))).toEqual(next);
        expect(report.after.info).toEqual({ title: 'Omada', version: 'v0.1' });
    });

    it.each(['{"openapi":', '{}', JSON.stringify({ ...document(), openapi: '3.1.0' }), JSON.stringify({ ...document(), paths: {} })])(
        'rejects invalid or truncated input without file damage (%s)',
        async (invalid) => {
            const fixture = await files(invalid);
            await expect(refreshOpenapi({ ...fixture, write: true })).rejects.toThrow();
            expect(await readFile(fixture.target, 'utf8')).toBe(fixture.original);
        }
    );

    it('rejects unresolved references without overwriting the bundle', async () => {
        const next = document();
        next.components.schemas.Sites.items.$ref = '#/components/schemas/Missing';
        const fixture = await files(next);
        await expect(refreshOpenapi({ ...fixture, write: true })).rejects.toThrow('unresolved local reference');
        expect(await readFile(fixture.target, 'utf8')).toBe(fixture.original);
    });

    it('discloses existing vendor reference errors without hiding an otherwise unchanged document', async () => {
        const existing = document();
        existing.components.schemas.Sites.items.$ref = '#/components/schemas/Malformed/Name';
        const fixture = await files(existing);
        await writeFile(fixture.target, JSON.stringify(existing));
        const report = await refreshOpenapi({ ...fixture, write: true });
        expect(report).toMatchObject({
            documentChanged: false,
            written: false,
            comparisonComplete: false,
            beforeUnresolvedReferences: ['#/components/schemas/Malformed/Name'],
            afterUnresolvedReferences: ['#/components/schemas/Malformed/Name'],
        });
    });

    it('bounds HTTPS input and requests no redirects or authentication', async () => {
        const fixture = await files();
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(document())));
        const report = await refreshOpenapi({ ...fixture, source: 'https://controller.test/v3/api-docs/00%20All', fetcher });
        expect(report.documentChanged).toBe(false);
        expect(fetcher).toHaveBeenCalledWith(new URL('https://controller.test/v3/api-docs/00%20All'), {
            redirect: 'error',
            signal: expect.any(AbortSignal),
            headers: { Accept: 'application/json' },
        });
        fetcher.mockResolvedValue(new Response('too large', { headers: { 'content-length': '16777217' } }));
        await expect(refreshOpenapi({ ...fixture, source: 'https://controller.test/spec', write: true, fetcher })).rejects.toThrow('16 MiB');
        expect(await readFile(fixture.target, 'utf8')).toBe(fixture.original);
    });

    it.each(['https://user:password@controller.test/spec', 'https://controller.test/spec?token=secret', 'http://controller.test/spec'])(
        'rejects source URLs containing credentials or insecure transport without echoing their secrets',
        async (source) => {
            const fixture = await files();
            const fetcher = vi.fn();
            await expect(refreshOpenapi({ ...fixture, source, fetcher })).rejects.toThrow('Source URLs must use HTTPS without credentials');
            expect(fetcher).not.toHaveBeenCalled();
        }
    );
});
