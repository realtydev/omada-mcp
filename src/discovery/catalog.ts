import { createHash } from 'node:crypto';

export type ApiDocument = Record<string, unknown>;
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiParameter {
    name: string;
    in: 'path' | 'query' | 'header' | 'cookie';
    required: boolean;
    schema?: Record<string, unknown>;
    description?: string;
    style?: string;
    explode?: boolean;
}

export interface ApiOperation {
    operationId: string;
    method: ApiMethod;
    path: string;
    tags: string[];
    summary: string;
    description: string;
    deprecated: boolean;
    parameters: ApiParameter[];
    requestBody?: { required: boolean; contentType: string; schema: Record<string, unknown> };
    responseContentType?: string;
    responseSchema?: Record<string, unknown>;
    unsupportedReason?: string;
}

export interface ApiSearchOptions {
    allowsOperation?: (operation: ApiOperation) => boolean;
    query?: string;
    tag?: string;
    method?: string;
    limit?: number;
    readOnly?: boolean;
}

export type ApiOperationSummary = Pick<ApiOperation, 'operationId' | 'method' | 'path' | 'tags' | 'summary' | 'deprecated' | 'unsupportedReason'>;

export interface ApiSearchResult {
    source: 'live' | 'bundled';
    loadedAt: number;
    fallbackReason?: string;
    total: number;
    operations: ApiOperationSummary[];
}

export interface ApiOperationDescription extends ApiOperation {
    source: 'live' | 'bundled';
    loadedAt: number;
    fallbackReason?: string;
    schemaResolution: { complete: boolean; warnings: string[] };
}

const METHODS: ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_OPERATIONS = 10_000;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 5_000;

const SEARCH_ALIASES = [
    ['wifi', 'wireless', 'wlan', 'wlans', 'ssid', 'ssids'],
    ['router', 'routers', 'gateway', 'gateways'],
    ['restart', 'reboot'],
    ['ap', 'aps', 'eap', 'eaps'],
    ['client', 'clients', 'station', 'stations'],
    ['device', 'devices'],
    ['switch', 'switches'],
    ['port', 'ports'],
    ['network', 'networks'],
    ['route', 'routes'],
    ['peer', 'peers'],
    ['profile', 'profiles'],
    ['reservation', 'reservations'],
];

function searchTerms(value: string): string[] {
    return value
        .replace(/wi[\s-]+fi/gi, 'wifi')
        .replace(/access[\s-]+points?/gi, 'ap')
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

function searchScore(operation: ApiOperation, query: string, terms: string[]): number {
    if (query && operation.operationId.toLowerCase() === query.toLowerCase()) return 10_000;
    const fields = [
        { value: operation.operationId, weight: 12 },
        { value: operation.summary, weight: 8 },
        { value: operation.tags.join(' '), weight: 6 },
        { value: operation.path, weight: 3 },
        { value: operation.description, weight: 1 },
    ].map(({ value, weight }) => ({ value: value.toLowerCase(), tokens: searchTerms(value), weight }));
    let score = operation.deprecated ? 0 : 0.5;
    for (const term of terms) {
        const variants = SEARCH_ALIASES.find((group) => group.includes(term)) ?? [term];
        let best = 0;
        for (const field of fields) {
            if (field.value.includes(term)) best = Math.max(best, field.weight * 2);
            if (variants.some((variant) => field.tokens.includes(variant))) best = Math.max(best, field.weight);
        }
        // Every query term must match; a synonym improves discovery, never execution identity.
        if (best === 0) return -1;
        score += best;
    }
    return score;
}

function object(value: unknown): ApiDocument | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ApiDocument) : undefined;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function cleanDescription(value: unknown): string {
    return text(value)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .slice(0, 12_000);
}

function localReference(document: ApiDocument, reference: string): unknown {
    if (!reference.startsWith('#/')) throw new Error('Only local OpenAPI references are supported');
    let value: unknown = document;
    for (const segment of reference.slice(2).split('/')) {
        const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        const parent = object(value);
        if (!parent || !Object.hasOwn(parent, key)) throw new Error(`OpenAPI reference was not found: ${reference}`);
        value = parent[key];
    }
    return value;
}

function dereferenceRecord(document: ApiDocument, value: unknown): ApiDocument {
    const seen = new Set<string>();
    for (let depth = 0; depth < MAX_SCHEMA_DEPTH; depth++) {
        const current = object(value);
        if (!current) throw new Error('OpenAPI metadata must be an object');
        if (!Object.hasOwn(current, '$ref')) return current;
        const reference = current.$ref;
        if (typeof reference !== 'string' || seen.has(reference)) throw new Error('Invalid or cyclic OpenAPI metadata reference');
        seen.add(reference);
        value = localReference(document, reference);
    }
    throw new Error('OpenAPI metadata reference depth exceeded');
}

function publicPathReason(path: string): string | undefined {
    if (!/^\/openapi\/v[12]\/(?:\{omadacId\}|msp\/\{mspId\})(?:\/|$)/.test(path)) {
        return 'Execution supports controller- or MSP-scoped Open API v1/v2 paths only';
    }
    if (/[?#\\\s]/.test(path) || path.includes('//') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) || /%(?:2e|2f|5c|00)/i.test(path)) {
        return 'OpenAPI path contains unsafe path syntax';
    }
    return undefined;
}

function schemaObject(document: ApiDocument, value: unknown): ApiDocument | undefined {
    if (/^3\.1(?:\.|$)/.test(text(document.openapi)) && typeof value === 'boolean') return value ? {} : { not: {} };
    return object(value);
}

function parseParameters(document: ApiDocument, shared: unknown, own: unknown, path: string, reasons: string[]): ApiParameter[] {
    const parameters = new Map<string, ApiParameter>();
    for (const source of [shared, own]) {
        if (source === undefined) continue;
        if (!Array.isArray(source)) {
            reasons.push('OpenAPI parameters must be an array');
            continue;
        }
        if (source.length > 200) throw new Error('OpenAPI operation contains too many parameters');
        for (const entry of source) {
            try {
                const raw = dereferenceRecord(document, entry);
                const location = raw.in;
                if (typeof raw.name !== 'string' || !raw.name || !['path', 'query', 'header', 'cookie'].includes(text(location))) {
                    throw new Error('OpenAPI parameter has an invalid name or location');
                }
                if (raw.required !== undefined && typeof raw.required !== 'boolean')
                    throw new Error('OpenAPI parameter required flag must be boolean');
                const schema = schemaObject(document, raw.schema);
                if (!schema || raw.content !== undefined) throw new Error(`Parameter ${raw.name} has an unsupported schema or serialization`);
                const parameter: ApiParameter = {
                    name: raw.name,
                    in: location as ApiParameter['in'],
                    required: location === 'path' || raw.required === true,
                    schema,
                    ...(typeof raw.description === 'string' ? { description: cleanDescription(raw.description) } : {}),
                    ...(typeof raw.style === 'string' ? { style: raw.style } : {}),
                    ...(typeof raw.explode === 'boolean' ? { explode: raw.explode } : {}),
                };
                if (parameter.required && (location === 'header' || location === 'cookie')) {
                    reasons.push(`Required ${location} parameter ${raw.name} cannot be supplied through API discovery`);
                }
                parameters.set(`${location}:${raw.name}`, parameter);
            } catch (error) {
                reasons.push(error instanceof Error ? error.message : 'Invalid OpenAPI parameter');
            }
        }
    }
    for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
        const name = match[1];
        if (!parameters.has(`path:${name}`)) parameters.set(`path:${name}`, { name, in: 'path', required: true, schema: { type: 'string' } });
    }
    return [...parameters.values()];
}

function parseBody(document: ApiDocument, value: unknown, reasons: string[]): ApiOperation['requestBody'] {
    if (value === undefined) return undefined;
    try {
        const raw = dereferenceRecord(document, value);
        if (raw.required !== undefined && typeof raw.required !== 'boolean') throw new Error('OpenAPI request body required flag must be boolean');
        const content = object(raw.content);
        if (!content || Object.keys(content).length === 0) throw new Error('OpenAPI request body has no media type');
        const contentType = Object.keys(content).find((key) => /^application\/(?:json|[\w.+-]+\+json)(?:;|$)/i.test(key)) ?? Object.keys(content)[0];
        const media = object(content[contentType]);
        const schema = schemaObject(document, media?.schema);
        if (!schema) throw new Error('OpenAPI request body has no supported schema');
        if (/^multipart\/form-data(?:;|$)/i.test(contentType) && media?.encoding !== undefined) {
            const encoding = object(media.encoding);
            if (!encoding || Object.keys(encoding).length > 0) reasons.push('Explicit multipart encoding metadata is not supported for execution');
        }
        if (!/^application\/(?:json|[\w.+-]+\+json)(?:;|$)/i.test(contentType) && !/^multipart\/form-data(?:;|$)/i.test(contentType))
            reasons.push('Only JSON or multipart request bodies can be executed');
        return { required: raw.required === true, contentType, schema };
    } catch (error) {
        reasons.push(error instanceof Error ? error.message : 'Invalid OpenAPI request body');
        return undefined;
    }
}

function parseResponse(document: ApiDocument, value: unknown, warnings: string[]): { responseContentType?: string; responseSchema?: ApiDocument } {
    const responses = object(value);
    if (!responses) return {};
    const key =
        Object.keys(responses)
            .sort()
            .find((status) => /^2\d\d$/.test(status)) ?? 'default';
    if (!Object.hasOwn(responses, key)) return {};
    try {
        const response = dereferenceRecord(document, responses[key]);
        const content = object(response.content);
        if (!content) return {};
        const media = Object.keys(content).find((type) => type.includes('json')) ?? Object.keys(content)[0];
        return { responseContentType: media, responseSchema: schemaObject(document, object(content[media])?.schema) };
    } catch (error) {
        // Response metadata does not prevent a request, but descriptions disclose unresolved evidence.
        warnings.push(error instanceof Error ? error.message : 'Response metadata could not be resolved');
        return {};
    }
}

function operationSummary(operation: ApiOperation): ApiOperationSummary {
    const { operationId, method, path, tags, summary, deprecated, unsupportedReason } = operation;
    return { operationId, method, path, tags, summary, deprecated, ...(unsupportedReason ? { unsupportedReason } : {}) };
}

function expandSchema(
    document: ApiDocument,
    value: unknown,
    warnings: Set<string>,
    seen = new Set<string>(),
    depth = 0,
    budget = { nodes: 0 }
): unknown {
    if (++budget.nodes > MAX_SCHEMA_NODES || (typeof value === 'string' && value.length > 4_000)) {
        warnings.add('Schema expansion was bounded; inspect the retained reference or schema separately');
        return { 'x-discovery-truncated': true };
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_SCHEMA_DEPTH) {
        warnings.add('Schema expansion was bounded; inspect the retained reference or schema separately');
        const reference = object(value)?.$ref;
        return { ...(typeof reference === 'string' ? { $ref: reference } : {}), 'x-discovery-truncated': true };
    }
    if (Array.isArray(value)) {
        const result: unknown[] = [];
        for (const entry of value) {
            if (budget.nodes >= MAX_SCHEMA_NODES) {
                warnings.add('Schema expansion was bounded; inspect the retained reference or schema separately');
                result.push({ 'x-discovery-truncated': true });
                break;
            }
            result.push(expandSchema(document, entry, warnings, seen, depth + 1, budget));
        }
        return result;
    }
    const source = value as ApiDocument;
    if (Object.hasOwn(source, '$ref')) {
        const reference = source.$ref;
        if (typeof reference !== 'string') {
            warnings.add('Invalid schema reference');
            return { 'x-discovery-unresolved': true };
        }
        try {
            if (seen.has(reference)) throw new Error(`Cyclic schema reference: ${reference}`);
            const next = new Set(seen).add(reference);
            const referenced = expandSchema(document, localReference(document, reference), warnings, next, depth + 1, budget);
            const siblings = Object.fromEntries(Object.entries(source).filter(([key]) => key !== '$ref'));
            if (/^3\.1(?:\.|$)/.test(text(document.openapi)) && Object.keys(siblings).length) {
                return { allOf: [referenced, expandSchema(document, siblings, warnings, seen, depth + 1, budget)] };
            }
            return referenced;
        } catch (error) {
            warnings.add(error instanceof Error ? error.message : 'Schema reference could not be resolved');
            return { $ref: reference, 'x-discovery-unresolved': true };
        }
    }
    const result: ApiDocument = Object.create(null);
    for (const [key, child] of Object.entries(source)) {
        if (budget.nodes >= MAX_SCHEMA_NODES) {
            warnings.add('Schema expansion was bounded; inspect the retained reference or schema separately');
            result['x-discovery-truncated'] = true;
            break;
        }
        result[key] = expandSchema(document, child, warnings, seen, depth + 1, budget);
    }
    return result;
}

/** A searchable, bounded index of one controller or bundled OpenAPI document. */
export class OperationCatalog {
    public readonly loadedAt = Date.now();
    public readonly operations: ApiOperation[];
    private readonly byId = new Map<string, ApiOperation>();
    private readonly documentationWarnings = new Map<ApiOperation, string[]>();

    constructor(
        public readonly document: ApiDocument,
        public readonly source: 'live' | 'bundled',
        public readonly fallbackReason?: string
    ) {
        if (!/^3\.\d+(?:\.|$)/.test(text(document.openapi)) || !object(document.paths)) throw new Error('A valid OpenAPI 3 document is required');
        if (Buffer.byteLength(JSON.stringify(document)) > MAX_DOCUMENT_BYTES) throw new Error('OpenAPI document exceeds the 32 MiB limit');
        const paths = document.paths as ApiDocument;
        if (Object.keys(paths).length > MAX_OPERATIONS) throw new Error('OpenAPI document contains too many paths');
        const operations: ApiOperation[] = [];
        for (const [path, item] of Object.entries(paths)) {
            if (path.length > 2_048) throw new Error('OpenAPI path exceeds the length limit');
            const pathItem = dereferenceRecord(document, item);
            for (const method of METHODS) {
                if (!Object.hasOwn(pathItem, method.toLowerCase())) continue;
                const raw = object(pathItem[method.toLowerCase()]);
                if (!raw) throw new Error(`OpenAPI ${method} operation metadata must be an object`);
                const reasons: string[] = [];
                const pathReason = publicPathReason(path);
                if (pathReason) reasons.push(pathReason);
                const parameters = parseParameters(document, pathItem.parameters, raw.parameters, path, reasons);
                const requestBody = parseBody(document, raw.requestBody, reasons);
                const operationId =
                    text(raw.operationId).trim() || `${method.toLowerCase()}_${createHash('sha256').update(path).digest('hex').slice(0, 12)}`;
                if (operationId.length > 256) throw new Error('OpenAPI operation ID exceeds the length limit');
                const warnings: string[] = [];
                const operation: ApiOperation = {
                    operationId,
                    method,
                    path,
                    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
                    summary: text(raw.summary).slice(0, 2_000),
                    description: cleanDescription(raw.description),
                    deprecated: raw.deprecated === true,
                    parameters,
                    ...(requestBody ? { requestBody } : {}),
                    ...parseResponse(document, raw.responses, warnings),
                    ...(reasons.length ? { unsupportedReason: [...new Set(reasons)].join('; ') } : {}),
                };
                this.documentationWarnings.set(operation, warnings);
                operations.push(operation);
                if (operations.length > MAX_OPERATIONS) throw new Error('OpenAPI document contains too many operations');
            }
        }
        if (operations.length === 0) throw new Error('OpenAPI document contains no supported HTTP operations');
        const counts = new Map<string, number>();
        for (const operation of operations)
            counts.set(operation.operationId.toLowerCase(), (counts.get(operation.operationId.toLowerCase()) ?? 0) + 1);
        for (const operation of operations) {
            if ((counts.get(operation.operationId.toLowerCase()) ?? 0) > 1) {
                operation.operationId += `__${operation.method.toLowerCase()}_${createHash('sha256').update(operation.path).digest('hex').slice(0, 12)}`;
            }
            if (this.byId.has(operation.operationId.toLowerCase())) throw new Error('OpenAPI operation IDs could not be disambiguated');
            this.byId.set(operation.operationId.toLowerCase(), operation);
        }
        this.operations = operations;
    }

    public get(operationId: string): ApiOperation | undefined {
        return this.byId.get(operationId.trim().toLowerCase());
    }

    public search(options: ApiSearchOptions = {}): ApiSearchResult {
        const limit = options.limit ?? 20;
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Search limit must be an integer from 1 to 50');
        const method = options.method?.toUpperCase();
        if (method && !METHODS.includes(method as ApiMethod)) throw new Error('Unsupported search HTTP method');
        if ((options.query?.length ?? 0) > 256 || (options.tag?.length ?? 0) > 128) throw new Error('Search query or tag is too long');
        const query = options.query?.trim() ?? '';
        const terms = searchTerms(query);
        const tag = options.tag?.toLowerCase().trim();
        const matches = this.operations
            .filter((operation) => !options.allowsOperation || options.allowsOperation(operation))
            .filter((operation) => (!options.readOnly || operation.method === 'GET') && (!method || operation.method === method))
            .filter((operation) => !tag || operation.tags.some((entry) => entry.toLowerCase().includes(tag)))
            .map((operation) => ({ operation, score: searchScore(operation, query, terms) }))
            .filter((match) => match.score >= 0)
            .sort((a, b) => b.score - a.score || a.operation.operationId.localeCompare(b.operation.operationId));
        return {
            source: this.source,
            loadedAt: this.loadedAt,
            ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
            total: matches.length,
            operations: matches.slice(0, limit).map(({ operation }) => operationSummary(operation)),
        };
    }

    public describe(operationId: string, options: { readOnly?: boolean } = {}): ApiOperationDescription {
        const operation = this.get(operationId);
        if (!operation) throw new Error(`Unknown API operation: ${operationId}`);
        if (options.readOnly && operation.method !== 'GET') throw new Error('The read-only profile does not expose write operations');
        const warnings = new Set<string>(this.documentationWarnings.get(operation));
        const budget = { nodes: 0 };
        const parameters = operation.parameters.map((parameter) => ({
            ...parameter,
            ...(parameter.schema ? { schema: expandSchema(this.document, parameter.schema, warnings, new Set(), 0, budget) as ApiDocument } : {}),
        }));
        return {
            ...operation,
            parameters,
            ...(operation.requestBody
                ? {
                      requestBody: {
                          ...operation.requestBody,
                          schema: expandSchema(this.document, operation.requestBody.schema, warnings, new Set(), 0, budget) as ApiDocument,
                      },
                  }
                : {}),
            ...(operation.responseSchema
                ? { responseSchema: expandSchema(this.document, operation.responseSchema, warnings, new Set(), 0, budget) as ApiDocument }
                : {}),
            source: this.source,
            loadedAt: this.loadedAt,
            ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
            schemaResolution: { complete: warnings.size === 0, warnings: [...warnings] },
        };
    }
}
