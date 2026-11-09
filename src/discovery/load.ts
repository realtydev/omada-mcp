import { readFile } from 'node:fs/promises';
import { type ApiDocument, OperationCatalog } from './catalog.js';

const MAX_SPEC_BYTES = 16 * 1024 * 1024;
const MAX_GROUPS = 32;
export type SpecMode = 'auto' | 'live' | 'bundled';
export type SpecFetcher = (path: string) => Promise<unknown>;

function document(value: unknown): ApiDocument {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Controller did not return an OpenAPI document');
    const result = value as ApiDocument;
    if (
        typeof result.openapi !== 'string' ||
        !result.openapi.startsWith('3.0.') ||
        !result.paths ||
        typeof result.paths !== 'object' ||
        Array.isArray(result.paths)
    ) {
        throw new Error('Expected an OpenAPI 3.0 document with paths');
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_SPEC_BYTES) throw new Error('OpenAPI document exceeds the 16 MiB limit');
    return result;
}

export async function loadBundledApiDocument(): Promise<ApiDocument> {
    const data = await readFile(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8');
    if (Buffer.byteLength(data) > MAX_SPEC_BYTES) throw new Error('Bundled OpenAPI document exceeds the size limit');
    return document(JSON.parse(data));
}

/** Only the configured controller's documentation paths may be fetched, never schema reference URLs. */
function hasControlCharacters(value: string): boolean {
    return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function documentationPath(value: unknown): string {
    if (typeof value !== 'string' || !value || /^[a-z][a-z\d+.-]*:|^\/\//i.test(value) || /[?#\\]/.test(value) || hasControlCharacters(value)) {
        throw new Error('Invalid controller documentation path');
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(value);
    } catch {
        throw new Error('Invalid controller documentation path');
    }
    if (decoded.split('/').some((part) => part === '.' || part === '..') || decoded.includes('\\') || hasControlCharacters(decoded)) {
        throw new Error('Invalid controller documentation path');
    }
    const target = new URL(value, 'https://documentation.invalid/v3/api-docs/');
    if (target.origin !== 'https://documentation.invalid' || !/^\/v3\/api-docs(?:\/|$)/.test(target.pathname)) {
        throw new Error('Invalid controller documentation path');
    }
    return target.pathname;
}

function mergeUnique(target: Record<string, unknown>, values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
        if (Object.hasOwn(target, key) && JSON.stringify(target[key]) !== JSON.stringify(value)) {
            throw new Error('Controller documentation groups contain conflicting definitions');
        }
        target[key] = value;
    }
}

async function liveDocument(fetcher: SpecFetcher): Promise<ApiDocument> {
    try {
        return document(await fetcher('/v3/api-docs/00%20All'));
    } catch {
        /* Try the controller's advertised groups next. */
    }
    let config: unknown;
    try {
        config = await fetcher('/v3/api-docs/swagger-config');
    } catch {
        config = undefined;
    }
    const urls = config && typeof config === 'object' ? (config as { urls?: unknown }).urls : undefined;
    if (Array.isArray(urls) && urls.length) {
        if (urls.length > MAX_GROUPS) throw new Error('Controller advertises too many OpenAPI groups');
        const groups = urls.map((item) => {
            if (!item || typeof item !== 'object') throw new Error('Invalid OpenAPI documentation group');
            const group = item as { name?: unknown; url?: unknown };
            return { name: group.name, path: documentationPath(group.url) };
        });
        const all = groups.find((group) => typeof group.name === 'string' && /\ball\b/i.test(group.name));
        if (all) return document(await fetcher(all.path));
        const merged: ApiDocument = { openapi: '3.0.1', info: {}, paths: Object.create(null), components: Object.create(null), tags: [] };
        for (const group of groups) {
            // All advertised groups must load: a partial catalogue must not masquerade as complete.
            const part = document(await fetcher(group.path));
            const paths = merged.paths as Record<string, unknown>;
            for (const [path, item] of Object.entries(part.paths as Record<string, unknown>)) {
                if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid OpenAPI path item');
                if (Object.hasOwn(paths, path)) {
                    const existing = paths[path] as Record<string, unknown>;
                    // Shared parameters must have identical meaning for every merged verb.
                    if (JSON.stringify(existing.parameters) !== JSON.stringify((item as Record<string, unknown>).parameters)) {
                        throw new Error('Controller documentation groups contain conflicting path parameters');
                    }
                    mergeUnique(existing, item as Record<string, unknown>);
                } else {
                    paths[path] = Object.assign(Object.create(null), item);
                }
            }
            const components = part.components;
            if (components && typeof components === 'object') {
                for (const [key, values] of Object.entries(components)) {
                    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid OpenAPI components');
                    const target = merged.components as Record<string, unknown>;
                    target[key] ??= Object.create(null);
                    mergeUnique(target[key] as Record<string, unknown>, values as Record<string, unknown>);
                }
            }
            if (Array.isArray(part.tags)) (merged.tags as unknown[]).push(...part.tags);
            document(merged);
        }
        return merged;
    }
    return document(await fetcher('/v3/api-docs'));
}

/** A single immutable snapshot per client, shared by concurrent searches/descriptions/executions. */
export class CatalogLoader {
    private pending?: Promise<OperationCatalog>;
    constructor(
        private readonly fetcher: SpecFetcher,
        private readonly mode: SpecMode = 'auto',
        private readonly bundled: () => Promise<ApiDocument> = loadBundledApiDocument
    ) {}

    public get(): Promise<OperationCatalog> {
        this.pending ??= this.load().catch((error: unknown) => {
            this.pending = undefined;
            throw error;
        });
        return this.pending;
    }

    private async load(): Promise<OperationCatalog> {
        if (this.mode === 'bundled') return new OperationCatalog(document(await this.bundled()), 'bundled');
        try {
            return new OperationCatalog(await liveDocument(this.fetcher), 'live');
        } catch {
            // Do not echo controller responses, URLs or credentials in a fallback reason.
            if (this.mode === 'live')
                throw new Error('Live OpenAPI discovery failed; verify controller documentation availability or use OMADA_API_SPEC=auto');
            return new OperationCatalog(document(await this.bundled()), 'bundled', 'Live controller specification unavailable or invalid');
        }
    }
}
