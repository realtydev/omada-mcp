#!/usr/bin/env node
/** Review a source document before explicitly adopting the full bundled OpenAPI snapshot. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TARGET = fileURLToPath(new URL('../docs/openapi/00-all.json', import.meta.url));
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => createHash('sha256').update(value).digest('hex');

function canonical(value, depth = 0, budget = { nodes: 0 }) {
    if (depth > 100 || ++budget.nodes > 1_000_000) throw new Error('API document exceeds structural complexity limits.');
    if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1, budget));
    if (!object(value)) return value;
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key], depth + 1, budget);
    return result;
}

function serialize(value) {
    return JSON.stringify(canonical(value));
}

function parseDocument(text) {
    let document;
    try {
        document = JSON.parse(text);
    } catch {
        throw new Error('Source is not complete, valid JSON; the bundled file was not changed.');
    }
    if (
        !object(document) ||
        typeof document.openapi !== 'string' ||
        !/^3\.0\.\d+$/.test(document.openapi) ||
        !object(document.info) ||
        typeof document.info.title !== 'string' ||
        typeof document.info.version !== 'string' ||
        !object(document.paths) ||
        (document.components !== undefined && !object(document.components))
    ) {
        throw new Error('Expected an OpenAPI 3.0 document with info.title, info.version and paths.');
    }
    if (!operations(document).size) throw new Error('API document contains no HTTP operations.');
    return document;
}

function reference(document, pointer) {
    if (!pointer.startsWith('#/')) throw new Error('API document contains a non-local reference; external references are not fetched.');
    let value = document;
    for (const segment of pointer.slice(2).split('/')) {
        const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!object(value) || !Object.hasOwn(value, key)) throw new Error('API document contains an unresolved local reference.');
        value = value[key];
    }
    return value;
}

function operations(document) {
    const result = new Map();
    for (const [path, item] of Object.entries(document.paths)) {
        if (!path.startsWith('/') || !object(item)) throw new Error('API paths must map absolute paths to path objects.');
        if (item.$ref !== undefined) throw new Error('Referenced path objects require manual review; inline them before refreshing.');
        const shared = Object.fromEntries(Object.entries(item).filter(([key]) => !METHODS.has(key)));
        for (const [method, operation] of Object.entries(item)) {
            if (!METHODS.has(method)) continue;
            if (!object(operation) || !object(operation.responses) || !Object.keys(operation.responses).length) {
                throw new Error('Every HTTP operation must have a non-empty responses object.');
            }
            const security = operation.security ?? document.security;
            const securitySchemes = Object.create(null);
            if (security !== undefined) {
                if (!Array.isArray(security) || security.some((entry) => !object(entry))) throw new Error('Invalid API security requirements.');
                for (const entry of security) {
                    for (const name of Object.keys(entry)) {
                        if (!Object.hasOwn(document.components?.securitySchemes ?? {}, name)) throw new Error('Missing API security scheme.');
                        securitySchemes[name] = document.components.securitySchemes[name];
                    }
                }
            }
            result.set(`${method.toUpperCase()} ${path}`, { shared, operation, ...(security === undefined ? {} : { security, securitySchemes }) });
        }
    }
    return result;
}

function signatures(document) {
    const result = new Map();
    const referenceHashes = new Map();
    const unresolved = new Set();
    for (const [key, operation] of operations(document)) {
        const refs = new Set();
        const pending = [operation];
        let nodes = 0;
        while (pending.length) {
            if (++nodes > 1_000_000) throw new Error('Operation reference graph exceeds complexity limits.');
            const value = pending.pop();
            if (!value || typeof value !== 'object') continue;
            if (Object.hasOwn(value, '$ref')) {
                if (typeof value.$ref !== 'string') throw new Error('API reference must be a string.');
                if (!refs.has(value.$ref)) {
                    refs.add(value.$ref);
                    let target;
                    let resolved = true;
                    try {
                        target = reference(document, value.$ref);
                    } catch {
                        resolved = false;
                        unresolved.add(value.$ref.startsWith('#/') ? value.$ref : '[external reference omitted]');
                        referenceHashes.set(value.$ref, 'unresolved');
                    }
                    if (resolved) {
                        if (!referenceHashes.has(value.$ref)) referenceHashes.set(value.$ref, hash(serialize(target)));
                        pending.push(target);
                    }
                }
            }
            pending.push(...Object.values(value));
        }
        const components = [...refs].sort().map((ref) => [ref, referenceHashes.get(ref)]);
        result.set(key, hash(serialize({ operation, components })));
    }
    return { operations: result, unresolved: [...unresolved].sort() };
}

/** Includes transitive request/response references, so unchanged operation IDs cannot hide schema drift. */
export function compareSpecs(before, after) {
    const previous = signatures(before);
    const next = signatures(after);
    return {
        beforeOperations: previous.operations.size,
        afterOperations: next.operations.size,
        comparisonComplete: previous.unresolved.length === 0 && next.unresolved.length === 0,
        beforeUnresolvedReferences: previous.unresolved,
        afterUnresolvedReferences: next.unresolved,
        added: [...next.operations.keys()].filter((key) => !previous.operations.has(key)).sort(),
        removed: [...previous.operations.keys()].filter((key) => !next.operations.has(key)).sort(),
        changed: [...next.operations.keys()]
            .filter((key) => previous.operations.has(key) && previous.operations.get(key) !== next.operations.get(key))
            .sort(),
    };
}

async function readBounded(stream) {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('API document exceeds the 16 MiB limit.');
        chunks.push(Buffer.from(chunk));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

async function loadSource(source, fetcher) {
    if (/^[a-z][a-z\d+.-]*:/i.test(source)) {
        let url;
        try {
            url = new URL(source);
        } catch {
            throw new Error('Source must be a local JSON file or an HTTPS URL.');
        }
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
            throw new Error('Source URLs must use HTTPS without credentials, query parameters or fragments.');
        }
        let response;
        try {
            response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('API document exceeds the 16 MiB limit.');
            if (!response.body) throw new Error('Empty response body');
            return { text: await readBounded(response.body), source: url.href };
        } catch (error) {
            const reason =
                error instanceof Error && /^(HTTP \d+|API document exceeds)/.test(error.message)
                    ? error.message
                    : 'connection, redirect or timeout failure';
            throw new Error(`Could not fetch the source API document: ${reason}.`);
        }
    }
    const path = resolve(source);
    try {
        return { text: await readBounded(createReadStream(path)), source: path };
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('API document exceeds')) throw error;
        throw new Error('Could not read the source API file; check that the file exists and is readable.');
    }
}

/** target/fetcher are injectable for isolated tests; the CLI only writes its fixed full bundled snapshot. */
export async function refreshOpenapi({ source, write = false, target = TARGET, fetcher = fetch }) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('An explicit --source file or HTTPS URL is required.');
    const loaded = await loadSource(source, fetcher);
    const after = parseDocument(loaded.text);
    let previousText;
    try {
        previousText = await readBounded(createReadStream(target));
    } catch {
        throw new Error('Could not read the existing bundled API document; no file was changed.');
    }
    const before = parseDocument(previousText);
    const diff = compareSpecs(before, after);
    const beforeHash = hash(serialize(before));
    const afterHash = hash(serialize(after));
    const documentChanged = beforeHash !== afterHash;
    let written = false;
    if (write && documentChanged) {
        if (diff.afterUnresolvedReferences.length) {
            throw new Error('Source contains unresolved local references or external references; review the report and resolve them before --write.');
        }
        const temporary = resolve(dirname(target), `.openapi-refresh-${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, `${JSON.stringify(after, null, 2)}\n`, { flag: 'wx' });
            await rename(temporary, target);
            written = true;
        } finally {
            await unlink(temporary).catch((error) => {
                if (error.code !== 'ENOENT') throw error;
            });
        }
    }
    return {
        source: loaded.source,
        target,
        documentChanged,
        written,
        before: {
            openapi: before.openapi,
            info: { title: before.info.title, version: before.info.version },
            sha256: hash(previousText),
            semanticSha256: beforeHash,
        },
        after: {
            openapi: after.openapi,
            info: { title: after.info.title, version: after.info.version },
            sha256: hash(loaded.text),
            semanticSha256: afterHash,
        },
        ...diff,
    };
}

const HELP = `Review a full Omada OpenAPI 3.0 snapshot (report-only by default).

Usage: node scripts/refresh-openapi.mjs --source <file.json|https://host/path> [--write]

--source  Required explicit source. HTTPS has a 10-second timeout, a 16 MiB limit,
          no redirects, no credentials and no query parameters. Local files are
          size-bounded too. Obtain the spec from your controller or TP-Link.
--write   Atomically adopt semantic changes in docs/openapi/00-all.json only.
          Other split snapshots and generated runtime files are not changed.
          Changed source documents must have resolvable local references.
--help    Show this help.

JSON output reports source/version/hashes and added, removed and changed HTTP
method/path pairs, including transitive referenced component changes. Arrays
retain order; object-key reordering is a no-op, including with --write.
Unresolved references make comparisonComplete false and are listed as warnings;
external references are never fetched. A partial comparison is not full proof
of compatibility. Unchanged documents with existing warnings remain a no-op.
Exit 0: review/adoption succeeded, including no changes. Exit 1: invalid input,
fetch or write failure. A change report alone never modifies the bundled file.
`;

async function main(args) {
    if (args.length === 1 && args[0] === '--help') {
        process.stdout.write(HELP);
        return;
    }
    let source;
    let write = false;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--source' && !source && args[i + 1] && !args[i + 1].startsWith('--')) source = args[++i];
        else if (args[i] === '--write' && !write) write = true;
        else throw new Error('Invalid arguments. Use --help for usage.');
    }
    process.stdout.write(`${JSON.stringify(await refreshOpenapi({ source, write }), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`OpenAPI refresh failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        process.exitCode = 1;
    });
}
