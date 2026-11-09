import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type ApiDocument, OperationCatalog } from './catalog.js';

const MAX_SPEC_BYTES = 16 * 1024 * 1024;
const MAX_GROUPS = 32;
export type SpecMode = 'auto' | 'live' | 'bundled';
export type SpecFetcher = (path: string) => Promise<unknown>;
export type SpecFailureReason =
    | 'http_error'
    | 'timeout'
    | 'tls_error'
    | 'connection_error'
    | 'unexpected_content'
    | 'invalid_document'
    | 'document_too_large'
    | 'invalid_configuration'
    | 'unsafe_documentation_path'
    | 'too_many_groups'
    | 'group_conflict'
    | 'request_failed';
export interface SpecAttempt {
    stage: 'combined' | 'configuration' | 'group' | 'default';
    group?: number;
    status: 'ok' | 'failed';
    reason?: SpecFailureReason;
    httpStatus?: number;
}
export interface CatalogDiagnostics {
    mode: SpecMode;
    attemptedAt: number;
    completedAt: number;
    attempts: SpecAttempt[];
}
export interface CatalogSnapshot {
    source: 'live' | 'bundled';
    loadedAt: number;
    schemaVersion: string;
    apiVersion?: string;
    documentHash: string;
    operations: number;
}

class SpecError extends Error {
    constructor(readonly reason: SpecFailureReason) {
        super(reason);
    }
}
export class CatalogLoadError extends Error {
    constructor(readonly diagnostics: CatalogDiagnostics) {
        super('Live OpenAPI discovery failed; verify controller documentation availability or use OMADA_API_SPEC=auto');
    }
}

/** Deliberately exclude exception messages, URLs, headers and response bodies. */
function failure(error: unknown): Pick<SpecAttempt, 'reason' | 'httpStatus'> {
    if (error instanceof SpecError) return { reason: error.reason };
    const value = error && typeof error === 'object' ? (error as { code?: unknown; response?: { status?: unknown } }) : undefined;
    const status = value?.response?.status;
    if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return { reason: 'http_error', httpStatus: status };
    const code = typeof value?.code === 'string' ? value.code : '';
    if (['ECONNABORTED', 'ETIMEDOUT'].includes(code)) return { reason: 'timeout' };
    if (/^(?:CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(code))
        return { reason: 'tls_error' };
    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH'].includes(code)) return { reason: 'connection_error' };
    return { reason: 'request_failed' };
}

export function catalogSnapshot(catalog: OperationCatalog): CatalogSnapshot {
    const info = catalog.document.info;
    const version = info && typeof info === 'object' ? (info as { version?: unknown }).version : undefined;
    return {
        source: catalog.source,
        loadedAt: catalog.loadedAt,
        schemaVersion: String(catalog.document.openapi),
        ...(typeof version === 'string' && version.length <= 80 && /^v?\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(version)
            ? { apiVersion: version }
            : {}),
        documentHash: createHash('sha256').update(JSON.stringify(catalog.document)).digest('hex'),
        operations: catalog.operations.length,
    };
}

function document(value: unknown): ApiDocument {
    if (typeof value === 'string' && /^\s*</.test(value)) throw new SpecError('unexpected_content');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpecError('invalid_document');
    const result = value as ApiDocument;
    if (
        typeof result.openapi !== 'string' ||
        !/^3\.[01](?:\.|$)/.test(result.openapi) ||
        !result.paths ||
        typeof result.paths !== 'object' ||
        Array.isArray(result.paths)
    ) {
        throw new SpecError('invalid_document');
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_SPEC_BYTES) throw new SpecError('document_too_large');
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
            throw new SpecError('group_conflict');
        }
        target[key] = value;
    }
}

async function liveDocument(fetcher: SpecFetcher, attempts: SpecAttempt[]): Promise<ApiDocument> {
    async function read<T>(path: string, stage: SpecAttempt['stage'], validate: (value: unknown) => T, group?: number): Promise<T> {
        try {
            const value = validate(await fetcher(path));
            attempts.push({ stage, ...(group === undefined ? {} : { group }), status: 'ok' });
            return value;
        } catch (error) {
            attempts.push({ stage, ...(group === undefined ? {} : { group }), status: 'failed', ...failure(error) });
            throw error;
        }
    }
    try {
        return await read('/v3/api-docs/00%20All', 'combined', document);
    } catch {
        /* Try the controller's advertised groups next. */
    }
    let config: unknown;
    try {
        config = await read('/v3/api-docs/swagger-config', 'configuration', (value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpecError('invalid_configuration');
            return value;
        });
    } catch {
        config = undefined;
    }
    const urls = config && typeof config === 'object' ? (config as { urls?: unknown }).urls : undefined;
    if (Array.isArray(urls) && urls.length) {
        if (urls.length > MAX_GROUPS) {
            attempts.push({ stage: 'configuration', status: 'failed', reason: 'too_many_groups' });
            throw new SpecError('too_many_groups');
        }
        const groups = urls.map((item) => {
            if (!item || typeof item !== 'object') throw new SpecError('invalid_configuration');
            const group = item as { name?: unknown; url?: unknown };
            try {
                return { name: group.name, path: documentationPath(group.url) };
            } catch {
                attempts.push({ stage: 'configuration', status: 'failed', reason: 'unsafe_documentation_path' });
                throw new SpecError('unsafe_documentation_path');
            }
        });
        const all = groups.find((group) => typeof group.name === 'string' && /\ball\b/i.test(group.name));
        if (all) return await read(all.path, 'group', document, groups.indexOf(all));
        const merged: ApiDocument = { openapi: '3.0.1', info: {}, paths: Object.create(null), components: Object.create(null), tags: [] };
        let hasDialect = false;
        for (const [index, group] of groups.entries()) {
            // All advertised groups must load: a partial catalogue must not masquerade as complete.
            const part = await read(group.path, 'group', document, index);
            if (!hasDialect) {
                hasDialect = true;
                merged.openapi = part.openapi;
                if (part.jsonSchemaDialect !== undefined) merged.jsonSchemaDialect = part.jsonSchemaDialect;
            } else if (part.openapi !== merged.openapi || part.jsonSchemaDialect !== merged.jsonSchemaDialect) {
                attempts.push({ stage: 'group', group: index, status: 'failed', reason: 'group_conflict' });
                throw new SpecError('group_conflict');
            }
            const paths = merged.paths as Record<string, unknown>;
            for (const [path, item] of Object.entries(part.paths as Record<string, unknown>)) {
                if (!item || typeof item !== 'object' || Array.isArray(item)) throw new SpecError('invalid_document');
                if (Object.hasOwn(paths, path)) {
                    const existing = paths[path] as Record<string, unknown>;
                    // Shared parameters must have identical meaning for every merged verb.
                    if (JSON.stringify(existing.parameters) !== JSON.stringify((item as Record<string, unknown>).parameters)) {
                        throw new SpecError('group_conflict');
                    }
                    mergeUnique(existing, item as Record<string, unknown>);
                } else {
                    paths[path] = Object.assign(Object.create(null), item);
                }
            }
            const components = part.components;
            if (components && typeof components === 'object') {
                for (const [key, values] of Object.entries(components)) {
                    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new SpecError('invalid_document');
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
    return await read('/v3/api-docs', 'default', document);
}

/** Immutable snapshots survive concurrent reads; explicit refresh replaces the cache only after successful loading. */
export class CatalogLoader {
    private cached?: OperationCatalog;
    private pending?: Promise<OperationCatalog>;
    private refreshing?: Promise<OperationCatalog>;
    private readonly reports = new WeakMap<OperationCatalog, CatalogDiagnostics>();
    constructor(
        private readonly fetcher: SpecFetcher,
        private readonly mode: SpecMode = 'auto',
        private readonly bundled: () => Promise<ApiDocument> = loadBundledApiDocument
    ) {}

    public get(): Promise<OperationCatalog> {
        if (this.cached) return Promise.resolve(this.cached);
        if (this.refreshing !== undefined) return this.refreshing;
        if (this.pending === undefined) {
            const pending = this.load().then((catalog) => {
                // A refresh that completed after this initial request began takes precedence.
                this.cached ??= catalog;
                return catalog;
            });
            this.pending = pending;
            void pending
                .finally(() => {
                    if (this.pending === pending) this.pending = undefined;
                })
                .catch(() => undefined);
        }
        return this.pending;
    }

    public refresh(): Promise<OperationCatalog> {
        if (this.refreshing === undefined) {
            const refreshing = this.load().then((catalog) => {
                this.cached = catalog;
                return catalog;
            });
            this.refreshing = refreshing;
            void refreshing
                .finally(() => {
                    if (this.refreshing === refreshing) this.refreshing = undefined;
                })
                .catch(() => undefined);
        }
        return this.refreshing;
    }

    public peek(): OperationCatalog | undefined {
        return this.cached;
    }

    public diagnostics(catalog: OperationCatalog): CatalogDiagnostics | undefined {
        const report = this.reports.get(catalog);
        return report ? structuredClone(report) : undefined;
    }

    private async load(): Promise<OperationCatalog> {
        const attemptedAt = Date.now();
        const attempts: SpecAttempt[] = [];
        let catalog: OperationCatalog;
        if (this.mode === 'bundled') catalog = new OperationCatalog(document(await this.bundled()), 'bundled');
        else {
            try {
                catalog = new OperationCatalog(await liveDocument(this.fetcher, attempts), 'live');
            } catch (error) {
                // Merge/assembly errors can happen after a successful fetch. Report their reason without vendor text.
                const reason = failure(error);
                if (!attempts.some((attempt) => attempt.status === 'failed' && attempt.reason === reason.reason))
                    attempts.push({ stage: 'group', status: 'failed', ...reason });
                const diagnostics = { mode: this.mode, attemptedAt, completedAt: Date.now(), attempts };
                if (this.mode === 'live') throw new CatalogLoadError(diagnostics);
                catalog = new OperationCatalog(document(await this.bundled()), 'bundled', 'Live controller specification unavailable or invalid');
            }
        }
        this.reports.set(catalog, { mode: this.mode, attemptedAt, completedAt: Date.now(), attempts });
        return catalog;
    }
}
