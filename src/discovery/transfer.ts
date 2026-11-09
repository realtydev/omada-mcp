import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { AxiosRequestConfig } from 'axios';
import type { ApiOperation, OperationCatalog } from './catalog.js';

type Schema = Record<string, unknown>;
export interface TransferOptions {
    body?: unknown;
    files?: Record<string, string | string[]>;
    downloadFile?: string;
    dryRun?: boolean;
}
export interface TransferContext {
    transferDirectory?: string;
    maxTransferBytes?: number;
}
export interface PreparedTransfer {
    validationBody?: unknown;
    preview?: unknown;
    request?: AxiosRequestConfig;
    finalize?: (response: unknown) => Promise<unknown>;
}
const DEFAULT_MAX = 16 * 1024 * 1024;
interface TransferRoot {
    path: string;
    dev: number;
    ino: number;
}
function record(value: unknown): value is Schema {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function resolve(schema: Schema, catalog: OperationCatalog, seen = new Set<string>()): Schema {
    if (schema.$ref === undefined) return schema;
    if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/components/schemas/') || seen.has(schema.$ref)) {
        throw new Error('Unsupported multipart schema reference');
    }
    seen.add(schema.$ref);
    let value: unknown = catalog.document;
    for (const segment of schema.$ref.slice(2).split('/')) {
        const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!record(value) || !Object.hasOwn(value, key)) throw new Error('Unresolved multipart schema reference');
        value = value[key];
    }
    if (!record(value)) throw new Error('Invalid multipart schema');
    return resolve(value, catalog, seen);
}
function filename(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !value ||
        value.length > 200 ||
        value.startsWith('.') ||
        /[/\\]/.test(value) ||
        isAbsolute(value) ||
        [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    ) {
        throw new Error('Transfer filenames must be ordinary basenames inside OMADA_TRANSFER_DIR');
    }
    return value;
}
async function directory(context: TransferContext): Promise<TransferRoot> {
    if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY)
        throw new Error('Secure file transfers require no-follow filesystem support; use Docker on this host');
    if (!context.transferDirectory || !isAbsolute(context.transferDirectory))
        throw new Error('File transfers require an absolute OMADA_TRANSFER_DIR');
    const root = await realpath(context.transferDirectory);
    const info = await lstat(root);
    if (!info.isDirectory() || (info.mode & 0o022) !== 0)
        throw new Error('OMADA_TRANSFER_DIR must be a private directory without group/world write access');
    return { path: root, dev: info.dev, ino: info.ino };
}
async function verifyRoot(root: TransferRoot): Promise<void> {
    const info = await lstat(root.path);
    if (
        !info.isDirectory() ||
        info.dev !== root.dev ||
        info.ino !== root.ino ||
        (info.mode & 0o022) !== 0 ||
        (await realpath(root.path)) !== root.path
    ) {
        throw new Error('Transfer directory changed during the operation');
    }
}
async function withRootFile<T>(
    root: TransferRoot,
    name: string,
    flags: number,
    mode: number | undefined,
    use: (file: FileHandle) => Promise<T>
): Promise<T> {
    await verifyRoot(root);
    const directoryHandle = await open(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        const info = await directoryHandle.stat();
        if (info.dev !== root.dev || info.ino !== root.ino) throw new Error('Transfer directory changed during the operation');
        // Linux containers can anchor child operations to the directory inode. Other hosts
        // recheck the operator-controlled directory around opens; it must not be replaced concurrently.
        const target = process.platform === 'linux' ? `/proc/self/fd/${directoryHandle.fd}/${name}` : join(root.path, name);
        const file = await open(target, flags, mode);
        try {
            await verifyRoot(root);
            return await use(file);
        } finally {
            await file.close();
        }
    } finally {
        await directoryHandle.close();
    }
}
function limit(context: TransferContext): number {
    const bytes = context.maxTransferBytes ?? DEFAULT_MAX;
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 64 * 1024 * 1024) throw new Error('Invalid file transfer size limit');
    return bytes;
}
async function readUpload(root: TransferRoot, name: string, maximum: number, preview: boolean): Promise<{ bytes: number; data?: Buffer }> {
    return await withRootFile(root, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, undefined, async (handle) => {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maximum) throw new Error('Upload must be a regular file within the transfer size limit');
        if (preview) return { bytes: info.size };
        const data = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
        let offset = 0;
        while (offset < data.length) {
            const { bytesRead } = await handle.read(data, offset, data.length - offset, null);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        if (offset !== info.size || offset > maximum) throw new Error('Upload changed while being read; preview the file again');
        return { bytes: offset, data: data.subarray(0, offset) };
    });
}

/** Prepare bounded, explicitly requested file transfers; ordinary JSON operations return undefined. */
export async function prepareTransfer(
    operation: ApiOperation,
    catalog: OperationCatalog,
    options: TransferOptions,
    context: TransferContext
): Promise<PreparedTransfer | undefined> {
    const multipart = operation.requestBody?.contentType.toLowerCase().startsWith('multipart/form-data');
    if (!multipart && options.files !== undefined) throw new Error('This operation does not accept multipart files');
    if (options.downloadFile !== undefined) {
        if (operation.method !== 'GET' || multipart || options.files !== undefined) throw new Error('File downloads require a GET operation');
        const root = await directory(context);
        const name = filename(options.downloadFile);
        const maximum = limit(context);
        try {
            await lstat(join(root.path, name));
            throw new Error('Download target already exists; overwrites are not allowed');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return {
            preview: { download: { file: name, maxBytes: maximum } },
            request: { responseType: 'arraybuffer', maxContentLength: maximum },
            finalize: async (response) => {
                if (!Buffer.isBuffer(response) && !(response instanceof Uint8Array) && !(response instanceof ArrayBuffer))
                    throw new Error('Controller did not return a binary file');
                const data = Buffer.from(
                    response instanceof ArrayBuffer ? response : response.buffer,
                    response instanceof ArrayBuffer ? 0 : response.byteOffset,
                    response instanceof ArrayBuffer ? response.byteLength : response.byteLength
                );
                if (!data.length || data.length > maximum) throw new Error('Download is empty or exceeds the transfer size limit');
                const prefix = data.subarray(0, 512).toString('utf8').trimStart();
                if (/^<!doctype\s+html|^<html/i.test(prefix)) throw new Error('Controller returned an HTML page instead of a file');
                if (prefix.startsWith('{')) {
                    try {
                        const value: unknown = JSON.parse(data.toString('utf8'));
                        if (record(value) && Object.hasOwn(value, 'errorCode'))
                            throw new Error('Controller returned an API envelope instead of a file; inspect the JSON operation response');
                    } catch (error) {
                        if (!(error instanceof SyntaxError)) throw error;
                    }
                }
                await withRootFile(
                    root,
                    name,
                    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
                    0o600,
                    async (handle) => {
                        // Keep a failed partial output for explicit inspection rather than unlinking
                        // through a path that an external host process could have changed.
                        await handle.writeFile(data);
                    }
                );
                return { file: name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
            },
        };
    }
    if (!multipart) return undefined;
    const root = await directory(context);
    const maximum = limit(context);
    const preview = options.dryRun ?? operation.method !== 'GET';
    const schema = resolve(operation.requestBody!.schema, catalog);
    if (!record(schema.properties)) throw new Error('Multipart operations require declared fields');
    if (options.body !== undefined && !record(options.body)) throw new Error('Multipart body fields must be an object');
    const fields = Object.assign(Object.create(null), options.body ?? {}) as Schema;
    const form = preview ? undefined : new FormData();
    const files: { field: string; file: string; bytes: number }[] = [];
    let total = 0;
    for (const [field, input] of Object.entries(options.files ?? {})) {
        if (!Object.hasOwn(schema.properties, field) || !record(schema.properties[field]))
            throw new Error('File field is not declared by this operation');
        if (Object.hasOwn(fields, field)) throw new Error('Do not supply a file field in both body and files');
        const property = resolve(schema.properties[field], catalog);
        const array = property.type === 'array';
        const item = array && record(property.items) ? resolve(property.items, catalog) : property;
        if (item.type !== 'string' || item.format !== 'binary') throw new Error('File field is not a declared binary upload');
        const names = Array.isArray(input) ? input : [input];
        if ((!array && names.length !== 1) || !names.length || files.length + names.length > 8)
            throw new Error('Multipart file count or shape is invalid');
        const normalized = [];
        for (const inputName of names) {
            const name = filename(inputName);
            const file = await readUpload(root, name, maximum - total, preview);
            total += file.bytes;
            files.push({ field, file: name, bytes: file.bytes });
            normalized.push(name);
            if (form && file.data) form.append(field, new Blob([new Uint8Array(file.data)]), name);
        }
        fields[field] = array ? normalized : normalized[0];
    }
    for (const [field, value] of Object.entries(fields)) {
        if (Object.hasOwn(options.files ?? {}, field)) continue;
        const declared = schema.properties[field];
        if (record(declared) && resolve(declared, catalog).format === 'binary') throw new Error('Upload binary fields through files, not body');
        if (form) form.append(field, typeof value === 'object' ? new Blob([JSON.stringify(value)], { type: 'application/json' }) : String(value));
    }
    return {
        validationBody: fields,
        preview: { upload: { files, bytes: total } },
        request: { data: form, headers: { 'Content-Type': 'multipart/form-data' }, maxBodyLength: maximum + 1024 * 1024 },
    };
}
