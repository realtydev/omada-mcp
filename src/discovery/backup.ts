import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { RequestHandler } from '../omadaClient/request.js';
import { verifyWrite } from '../utils/write-verification.js';
import type { ApiOperation } from './catalog.js';
import type { ResourceRead } from './resourceInventory.js';

const ROOT = '/openapi/v1/{omadacId}';
export function isManagedBackup(operation: Pick<ApiOperation, 'method' | 'path'>): boolean {
    return (
        operation.method === 'POST' &&
        [`${ROOT}/maintenance/backup/self-server`, `${ROOT}/sites/maintenance/multi-backup/self-server`].includes(operation.path)
    );
}
const siteIds = z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, 'Site IDs must be unique');
export function backupSites(operation: ApiOperation, body: unknown): Array<string | undefined> {
    return operation.path.includes('/multi-backup/') ? z.object({ siteIds }).parse(body).siteIds : [undefined];
}
const fileSchema = z.object({ fileName: z.string().min(1).max(128), backupTime: z.number().int().nonnegative(), size: z.number().int().positive() });
const fileList = z.object({ fileList: z.array(fileSchema).max(1000) });
const statusSchema = z.object({ status: z.union([z.literal(0), z.literal(1)]) });

/** These documented backup reads may return bare objects instead of Open API envelopes. */
export function backupReadSchema(operation: Pick<ApiOperation, 'method' | 'path'>) {
    if (operation.method !== 'GET') return undefined;
    if ([`${ROOT}/maintenance/backup/result`, `${ROOT}/sites/{siteId}/backup/result`].includes(operation.path)) return statusSchema;
    if ([`${ROOT}/maintenance/backup/files`, `${ROOT}/sites/{siteId}/maintenance/backup/files`].includes(operation.path)) return fileList;
    return undefined;
}

/** A zero status also means "init"; only a new file establishes observed backup completion. */
export async function executeBackup(request: RequestHandler, operation: ApiOperation, path: string, body: unknown, read: ResourceRead) {
    const targets = backupSites(operation, body);
    const inspect = async (siteId: string | undefined) => {
        const statusPath = siteId ? `${ROOT}/sites/{siteId}/backup/result` : `${ROOT}/maintenance/backup/result`;
        const filesPath = siteId ? `${ROOT}/sites/{siteId}/maintenance/backup/files` : `${ROOT}/maintenance/backup/files`;
        const status = statusSchema.parse(await read(statusPath, { siteId })).status;
        const files = fileList.parse(await read(filesPath, { siteId })).fileList;
        if (new Set(files.map((file) => file.fileName)).size !== files.length) throw new Error('Backup file inventory is ambiguous');
        return { siteId, status, files };
    };
    const before: Array<Awaited<ReturnType<typeof inspect>>> = [];
    for (const siteId of targets) {
        const snapshot = await inspect(siteId);
        if (snapshot.status !== 0) throw new Error('A backup is already running; no backup was submitted');
        before.push(snapshot);
    }
    let response: unknown,
        acknowledged = false;
    try {
        response = await request.request(
            { method: 'POST', url: path, data: body, maxContentLength: 8 * 1024 * 1024, maxBodyLength: 1024 * 1024 },
            false
        );
    } catch (error) {
        const status = error && typeof error === 'object' ? (error as { status?: number }).status : undefined;
        if (status && status >= 400 && status < 500 && status !== 408) throw error;
    }
    if (response && typeof response === 'object' && Number.isInteger((response as { errorCode?: unknown }).errorCode)) {
        request.ensureSuccess(response as { errorCode: number; result: unknown });
        acknowledged = true;
    }
    const verification = await verifyWrite(
        async () => {
            const snapshots = [];
            for (const siteId of targets) snapshots.push(await inspect(siteId));
            return snapshots;
        },
        (snapshots) =>
            snapshots.every(
                (snapshot, i) =>
                    snapshot.status === 0 &&
                    snapshot.files.filter((file) => !before[i].files.some((old) => isDeepStrictEqual(old, file))).length === 1
            )
    );
    const verified = verification.status === 'verified';
    return {
        written: acknowledged ? (true as const) : ('unknown' as const),
        verified,
        verification: { status: verified ? ('verified' as const) : ('unknown' as const), attempts: verification.attempts },
        result: {
            backups: (verification.observed ?? []).map((snapshot, i) => ({
                siteId: snapshot.siteId,
                status: snapshot.status,
                newFiles: snapshot.files.filter((file) => !before[i].files.some((old) => isDeepStrictEqual(old, file))),
            })),
        },
        warning: verified
            ? 'Observed new controller-side backup files; archive contents and restorability were not tested.'
            : 'Backup completion is unconfirmed after bounded polling. Inspect backup status/files before retrying; no mutation was replayed.',
    };
}
