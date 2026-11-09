import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

import type { RequestHandler } from '../omadaClient/request.js';
import type { ApiOperation, ApiParameter, OperationCatalog } from './catalog.js';

type Schema = Record<string, unknown>;
type QueryValue = string | number | boolean | Array<string | number | boolean>;

export interface ExecuteApiOperationOptions {
    operationId: string;
    params?: Record<string, unknown>;
    body?: unknown;
    dryRun?: boolean;
}

export interface DiscoveryExecutionContext {
    omadacId: string;
    siteId?: string;
    readOnly: boolean;
}

export interface DiscoveredExecutionResult {
    operationId: string;
    source: 'live' | 'bundled';
    loadedAt: number;
    dryRun: boolean;
    written: boolean;
    verified: false;
    request: { method: string; path: string; query: Record<string, QueryValue>; body?: unknown };
    result?: unknown;
    warning?: string;
}

const validators = new WeakMap<OperationCatalog, Map<string, ReturnType<AjvJsonSchemaValidator['getValidator']>>>();
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const controllerParameters = new Set(['omadacId', 'mspId']);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject non-JSON values and special object keys before validation or serialization. */
function assertJson(value: unknown, seen = new Set<unknown>(), depth = 0, budget = { nodes: 0 }): void {
    if (++budget.nodes > 20_000 || depth > 40) throw new Error('Operation input is too large or deeply nested.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || seen.has(value)) throw new Error('Operation input must contain finite JSON values without cycles.');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new Error('Operation input must contain plain JSON objects.');
    }
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
        if (forbiddenKeys.has(key)) throw new Error(`Operation input contains an unsupported property: ${key}.`);
        assertJson(child, seen, depth + 1, budget);
    }
    seen.delete(value);
}

function referencedSchema(document: Record<string, unknown>, reference: string): Schema {
    const match = /^#\/components\/schemas\/([^/]+)$/.exec(reference);
    if (!match) throw new Error('Only local OpenAPI component schema references are supported for execution.');
    const name = match[1].replace(/~1/g, '/').replace(/~0/g, '~');
    const components = document.components;
    const schemas = object(components) ? components.schemas : undefined;
    if (!object(schemas) || !Object.hasOwn(schemas, name) || !object(schemas[name]))
        throw new Error('Operation schema reference cannot be resolved.');
    return schemas[name];
}

function resolve(schema: Schema, document: Record<string, unknown>, seen = new Set<string>()): Schema {
    if (typeof schema.$ref !== 'string') return schema;
    if (seen.has(schema.$ref)) throw new Error('Circular schema cannot describe this parameter.');
    seen.add(schema.$ref);
    return resolve(referencedSchema(document, schema.$ref), document, seen);
}

/** Keep local references intact and include only their reachable components. No remote resolution. */
function validationSchema(operation: ApiOperation, catalog: OperationCatalog): Schema {
    const components: Record<string, Schema> = Object.create(null);
    const processing = new Set<string>();
    let nodes = 0;
    const copy = (value: unknown, depth = 0): unknown => {
        if (++nodes > 100_000 || depth > 100) throw new Error('Operation schema exceeds validation limits.');
        if (Array.isArray(value)) return value.map((entry) => copy(entry, depth + 1));
        if (!object(value)) return value;
        if (
            Object.hasOwn(value, '$id') ||
            Object.hasOwn(value, '$schema') ||
            Object.hasOwn(value, '$dynamicRef') ||
            Object.hasOwn(value, '$recursiveRef')
        ) {
            throw new Error('Operation uses an unsupported JSON Schema dialect or reference keyword.');
        }
        if (value.format === 'binary') throw new Error('Binary request fields require a dedicated tool.');
        if (typeof value.$ref === 'string') {
            const reference = value.$ref;
            const target = referencedSchema(catalog.document, reference);
            const name = reference.slice('#/components/schemas/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
            if (!Object.hasOwn(components, name) && !processing.has(name)) {
                processing.add(name);
                components[name] = copy(target, depth + 1) as Schema;
                processing.delete(name);
            }
        }
        const result: Schema = Object.create(null);
        for (const [key, child] of Object.entries(value)) result[key] = copy(child, depth + 1);
        for (const bound of ['Minimum', 'Maximum']) {
            const exclusive = `exclusive${bound}`;
            if (typeof result[exclusive] === 'boolean') {
                if (result[exclusive] === true) {
                    const ordinary = bound.toLowerCase();
                    if (typeof result[ordinary] !== 'number') throw new Error('Invalid exclusive bound in operation schema.');
                    result[exclusive] = result[ordinary];
                    delete result[ordinary];
                } else delete result[exclusive];
            }
        }
        return result;
    };
    const properties: Schema = Object.create(null);
    const required: string[] = [];
    for (const parameter of operation.parameters) {
        if (parameter.in !== 'query' && parameter.in !== 'path') continue;
        if (Object.hasOwn(properties, parameter.name)) throw new Error('Operation has ambiguous parameter names across locations.');
        properties[parameter.name] = copy(parameter.schema ?? { type: 'string' });
        if (parameter.required || parameter.in === 'path') required.push(parameter.name);
    }
    const rootProperties: Schema = { params: { type: 'object', properties, required, additionalProperties: false } };
    const rootRequired = ['params'];
    if (operation.requestBody) {
        rootProperties.body = copy(operation.requestBody.schema);
        if (operation.requestBody.required) rootRequired.push('body');
    }
    return {
        type: 'object',
        properties: rootProperties,
        required: rootRequired,
        additionalProperties: false,
        components: { schemas: components },
    };
}

function validate(operation: ApiOperation, catalog: OperationCatalog, input: Record<string, unknown>): void {
    let byOperation = validators.get(catalog);
    if (!byOperation) {
        byOperation = new Map();
        validators.set(catalog, byOperation);
    }
    let validator = byOperation.get(operation.operationId);
    if (!validator) {
        try {
            validator = new AjvJsonSchemaValidator().getValidator(validationSchema(operation, catalog));
        } catch (error) {
            throw new Error(`Operation cannot be validated safely: ${error instanceof Error ? error.message : 'invalid schema'}`);
        }
        byOperation.set(operation.operationId, validator);
    }
    const outcome = validator(input);
    if (!outcome.valid) throw new Error(`Invalid operation input: ${outcome.errorMessage ?? 'schema validation failed'}`);
}

function hasControl(value: string): boolean {
    return Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function safeSegment(value: unknown): string {
    if ((typeof value !== 'string' && typeof value !== 'number') || value === '' || value === '.' || value === '..') {
        throw new Error('Path parameters must be non-empty strings or numbers, not traversal segments.');
    }
    const text = String(value);
    if (/[%/\\?#]/.test(text) || hasControl(text)) throw new Error('Path parameters must not contain URL separators, escapes or control characters.');
    return encodeURIComponent(text);
}

function defaultPageSize(parameter: ApiParameter, catalog: OperationCatalog): number {
    const schema = resolve(parameter.schema ?? {}, catalog.document);
    const maximum = typeof schema.maximum === 'number' ? Math.floor(schema.maximum) : 100;
    const minimum = typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 1;
    if (Array.isArray(schema.enum)) {
        const allowed = schema.enum.filter(
            (value): value is number => Number.isInteger(value) && value >= minimum && value <= Math.min(100, maximum)
        );
        if (!allowed.length) throw new Error('Operation has no safely bounded default page size; supply pageSize explicitly.');
        return Math.max(...allowed);
    }
    const value = Math.min(100, maximum);
    if (value < minimum || value < 1) throw new Error('Operation has no safely bounded default page size; supply pageSize explicitly.');
    return value;
}

function primitive(value: unknown): value is string | number | boolean {
    return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function queryParameters(operation: ApiOperation, params: Record<string, unknown>, catalog: OperationCatalog): Record<string, QueryValue> {
    const query: Record<string, QueryValue> = Object.create(null);
    const put = (key: string, value: QueryValue) => {
        if (forbiddenKeys.has(key) || hasControl(key)) throw new Error('Unsupported query parameter name.');
        if (Object.hasOwn(query, key)) throw new Error(`Query parameter serialization collides at ${key}.`);
        query[key] = value;
    };
    const flatten = (value: unknown, schema: Schema, prefix: string, deepObject: boolean) => {
        if (primitive(value)) return put(prefix, value);
        if (Array.isArray(value) && value.every(primitive)) return put(prefix, value);
        if (!object(value)) throw new Error(`Cannot serialize query parameter ${prefix || '(object)'} without losing its value.`);
        const resolved = resolve(schema, catalog.document);
        const properties = object(resolved.properties) ? resolved.properties : {};
        for (const [key, child] of Object.entries(value)) {
            if (!Object.hasOwn(properties, key) || !object(properties[key])) throw new Error(`Query object contains an undocumented field: ${key}.`);
            const name = prefix ? (deepObject ? `${prefix}[${key}]` : `${prefix}.${key}`) : key;
            flatten(child, properties[key], name, deepObject);
        }
    };
    for (const parameter of operation.parameters) {
        if (parameter.in !== 'query' || !Object.hasOwn(params, parameter.name)) continue;
        const value = params[parameter.name];
        const schema = resolve(parameter.schema ?? {}, catalog.document);
        const style = parameter.style ?? 'form';
        if (object(value)) {
            if (style !== 'form' && style !== 'deepObject') throw new Error(`Unsupported object query serialization for ${parameter.name}.`);
            if (style === 'form' && parameter.explode === false) throw new Error(`Non-exploded query objects are not supported: ${parameter.name}.`);
            flatten(value, schema, style === 'deepObject' ? parameter.name : '', style === 'deepObject');
        } else if (Array.isArray(value)) {
            if (!value.every(primitive)) throw new Error(`Query arrays must contain scalar values: ${parameter.name}.`);
            if (!['form', 'spaceDelimited', 'pipeDelimited'].includes(style))
                throw new Error(`Unsupported array query serialization for ${parameter.name}.`);
            if (style !== 'form' || parameter.explode === false)
                put(parameter.name, value.join(style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ','));
            else put(parameter.name, value);
        } else if (primitive(value)) {
            if (style !== 'form') throw new Error(`Unsupported scalar query serialization for ${parameter.name}.`);
            put(parameter.name, value);
        } else throw new Error(`Cannot serialize query parameter ${parameter.name} without losing its value.`);
    }
    return query;
}

function rejectUnknownBodyFields(schema: Schema, body: unknown, catalog: OperationCatalog): void {
    if (!object(body)) return;
    const resolved = resolve(schema, catalog.document);
    // Explicit maps and composed schemas keep their published JSON Schema rules.
    if (resolved.additionalProperties !== undefined || resolved.allOf || resolved.anyOf || resolved.oneOf || !object(resolved.properties)) return;
    const unknown = Object.keys(body).find((key) => !Object.hasOwn(resolved.properties as object, key));
    if (unknown) throw new Error(`Request body contains an undocumented field: ${unknown}.`);
}

function preferredWriteTool(operation: ApiOperation): string | undefined {
    if (operation.method === 'GET') return undefined;
    if (/\/aps\/\{[^}]+\}\/radio-config$/.test(operation.path)) return 'setApRadio';
    if (/\/site\/log-notification$/.test(operation.path)) return 'setLogNotifications';
    if (/\/sites\/\{[^}]+\}\/wireless-network\/wlans\/\{[^}]+\}\/ssids\/\{[^}]+\}\/update-basic-config$/.test(operation.path)) return 'updateSsid';
    const switchPort =
        /\/sites\/\{[^}]+\}\/switches\/\{[^}]+\}\/(ports\/\{[^}]+\}|multi-ports)\/(profile|poe-mode|name|status|profile-override)$/.exec(
            operation.path
        );
    if (switchPort && operation.method === 'PUT') {
        const single: Record<string, string> = {
            profile: 'setSwitchPortProfile',
            'poe-mode': 'setSwitchPortPoe',
            name: 'setSwitchPortName',
            status: 'setSwitchPortStatus',
            'profile-override': 'setSwitchPortProfileOverride',
        };
        const batch: Record<string, string> = {
            'poe-mode': 'batchSetSwitchPortPoe',
            name: 'batchSetSwitchPortName',
            status: 'batchSetSwitchPortStatus',
            'profile-override': 'batchSetSwitchPortProfile',
        };
        return (switchPort[1] === 'multi-ports' ? batch : single)[switchPort[2]];
    }
    if (operation.method === 'PATCH' && /\/sites\/\{[^}]+\}\/switches\/\{[^}]+\}\/ports\/\{[^}]+\}$/.test(operation.path)) {
        return 'updateSwitchPort';
    }
    if (/\/setting\/service\/dhcp(?:\/\{[^}]+\})?$/.test(operation.path)) {
        if (operation.method === 'POST') return 'createDhcpReservation';
        if (operation.method === 'DELETE') return 'deleteDhcpReservation';
        return 'updateDhcpReservation';
    }
    return undefined;
}

/** Execute only a declared operation; this is not an arbitrary HTTP request interface. */
export async function executeDiscoveredOperation(
    catalog: OperationCatalog,
    request: RequestHandler,
    options: ExecuteApiOperationOptions,
    context: DiscoveryExecutionContext
): Promise<DiscoveredExecutionResult> {
    if (typeof options.operationId !== 'string' || !options.operationId.trim()) throw new Error('operationId is required.');
    const operation = catalog.get(options.operationId);
    if (!operation) throw new Error('Unknown or ambiguous operationId. Search and describe the operation first.');
    const mutation = operation.method !== 'GET';
    if (context.readOnly && mutation) throw new Error('Read-only profile blocks mutating API operations, including previews.');
    // The SDK validator implements draft-07 and OpenAPI 3.0, not 3.1's JSON Schema 2020 semantics.
    if (typeof catalog.document.openapi !== 'string' || !/^3\.0(?:\.|$)/.test(catalog.document.openapi)) {
        throw new Error('Execution requires OpenAPI 3.0 schema semantics; this specification remains available for search and description only.');
    }
    if (operation.unsupportedReason) throw new Error(`Operation execution is unsupported: ${operation.unsupportedReason}`);
    if (
        !/^\/openapi\/v[12]\/\{(?:omadacId|mspId)\}(?:\/[A-Za-z0-9_{}.-]+)*$/.test(operation.path) ||
        /(?:^|\/)\.{1,2}(?:\/|$)/.test(operation.path)
    ) {
        throw new Error('Operation path must be a public controller Open API path without traversal or URL overrides.');
    }
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method)) throw new Error('Unsupported operation method.');
    if (operation.parameters.some((parameter) => parameter.required && !['path', 'query'].includes(parameter.in))) {
        throw new Error('Operations requiring custom headers or cookies cannot be executed through discovery.');
    }
    if (operation.parameters.some((parameter) => parameter.in === 'path' && parameter.style !== undefined && parameter.style !== 'simple')) {
        throw new Error('Only simple path parameter serialization is supported.');
    }
    if (operation.responseSchema && resolve(operation.responseSchema, catalog.document).format === 'binary') {
        throw new Error('Binary downloads require a dedicated tool.');
    }
    if (
        operation.responseContentType &&
        operation.responseContentType !== '*/*' &&
        !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/i.test(operation.responseContentType.trim())
    ) {
        throw new Error('Only JSON responses are supported; binary downloads and exports require a dedicated tool.');
    }
    const contentType = operation.requestBody?.contentType.trim();
    if (contentType && !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/i.test(contentType)) {
        throw new Error('Only JSON request bodies are supported; use a dedicated tool for multipart, binary or form operations.');
    }
    if (operation.method === 'GET' && options.body !== undefined) throw new Error('GET operations cannot carry request bodies.');
    if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') throw new Error('dryRun must be a boolean.');
    if (options.params !== undefined && !object(options.params)) throw new Error('params must be an object.');
    if (options.params !== undefined) assertJson(options.params);
    if (options.body !== undefined) assertJson(options.body);
    const params: Record<string, unknown> = Object.assign(Object.create(null), options.params ?? {});
    const permitted = new Set(
        operation.parameters.filter((parameter) => parameter.in === 'path' || parameter.in === 'query').map((parameter) => parameter.name)
    );
    for (const name of Object.keys(params)) {
        if (controllerParameters.has(name)) throw new Error('Controller identifiers are supplied by server configuration and cannot be overridden.');
        if (!permitted.has(name)) throw new Error(`Unknown operation parameter: ${name}.`);
    }
    for (const parameter of operation.parameters) {
        if (controllerParameters.has(parameter.name)) params[parameter.name] = context.omadacId;
        else if (parameter.name === 'siteId' && params.siteId === undefined && context.siteId !== undefined) params.siteId = context.siteId;
        else if (parameter.in === 'query' && parameter.required && !Object.hasOwn(params, parameter.name)) {
            if (parameter.name === 'page') params.page = 1;
            if (parameter.name === 'pageSize') params.pageSize = defaultPageSize(parameter, catalog);
        }
    }
    const input: Record<string, unknown> = { params };
    if (options.body !== undefined) input.body = options.body;
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_REQUEST_BYTES) throw new Error('Operation input exceeds the 1 MiB execution limit.');
    validate(operation, catalog, input);
    if (operation.requestBody && options.body !== undefined) rejectUnknownBodyFields(operation.requestBody.schema, options.body, catalog);
    const path = operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => safeSegment(params[name]));
    if (/[{}]/.test(path)) throw new Error('Operation path contains malformed template parameters.');
    const query = queryParameters(operation, params, catalog);
    const dryRun = options.dryRun ?? mutation;
    const preferredTool = preferredWriteTool(operation);
    const metadata = { operationId: operation.operationId, source: catalog.source, loadedAt: catalog.loadedAt, verified: false as const };
    if (dryRun) {
        return {
            ...metadata,
            dryRun: true,
            written: false,
            request: { method: operation.method, path, query, ...(options.body === undefined ? {} : { body: options.body }) },
            ...(preferredTool ? { warning: `Actual writes use ${preferredTool} to preserve its preflight and read-back checks.` } : {}),
        };
    }
    if (preferredTool) throw new Error(`Use ${preferredTool} for this write to preserve its preflight and read-back verification.`);
    try {
        const response = await request.request<unknown>({
            method: operation.method,
            url: path,
            params: query,
            paramsSerializer: { indexes: null },
            maxContentLength: MAX_RESPONSE_BYTES,
            maxBodyLength: MAX_REQUEST_BYTES,
            ...(options.body === undefined ? {} : { data: options.body, headers: { 'Content-Type': contentType } }),
        });
        if (!object(response) || !Number.isInteger(response.errorCode)) throw new Error('Controller returned an invalid Open API response envelope.');
        const result = request.ensureSuccess(response as { errorCode: number; msg?: string; result: unknown });
        return {
            ...metadata,
            dryRun: false,
            written: mutation,
            request: { method: operation.method, path, query },
            result,
            ...(mutation
                ? {
                      warning:
                          'Controller accepted the request; discovery does not perform read-back verification. Prefer a dedicated tool when available.',
                  }
                : {}),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Controller request failed.';
        throw new Error(mutation ? `${message} The write may have applied; inspect controller state before retrying.` : message, { cause: error });
    }
}
