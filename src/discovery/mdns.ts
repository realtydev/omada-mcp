import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RequestHandler } from '../omadaClient/request.js';
import {
    type DnsChangeReceipt,
    type DnsWriteSafety,
    dnsChangeIdentifierSchema,
    dnsChangeReceipt,
    mdnsConfigFieldsSchema,
    mdnsConfigSchema,
    sameDnsConfig,
} from '../utils/dns-change-schema.js';
import { verifyWrite, type WriteVerification } from '../utils/write-verification.js';
import type { ApiOperation } from './catalog.js';

export const MDNS_PATH = '/openapi/v1/{omadacId}/sites/{siteId}/setting/service/mdns';
export const MDNS_PROFILES_PATH = '/openapi/v1/{omadacId}/sites/{siteId}/profiles/bonjour-service';
export const MDNS_NETWORKS_PATH = '/openapi/v1/{omadacId}/sites/{siteId}/lan-networks';
const fields = ['name', 'status', 'profileIds', 'type', 'ap', 'osg'] as const;
export type MdnsRow = Record<string, unknown> & { id: string };
export interface MdnsWriteResult {
    written: boolean | 'unknown';
    verified: boolean;
    result?: unknown;
    verification: Omit<WriteVerification<MdnsRow[]>, 'observed' | 'message'> & { resourceId?: string; observed?: MdnsRow };
    rollbackReceipt?: DnsChangeReceipt;
    rollbackUnavailable?: string;
    warning?: string;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const config = (value: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical).sort();
    if (object(value))
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'clientVlan' ? vlans(entry) : canonical(entry)]));
    return value;
}
function vlans(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const ranges = value
        .split(',')
        .map((part) => {
            const [first, last = first] = part.split('-').map(Number);
            return [first, last];
        })
        .sort((left, right) => left[0] - right[0]);
    const merged: number[][] = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
        else merged.push(range);
    }
    return merged;
}
function matches(row: MdnsRow, desired: Record<string, unknown>): boolean {
    return Object.entries(desired).every(([key, value]) => isDeepStrictEqual(canonical(row[key]), canonical(value)));
}
function sameRows(before: MdnsRow[], after: MdnsRow[]): boolean {
    return (
        before.length === after.length &&
        before.every((row) => {
            const other = after.find((item) => item.id === row.id);
            return other !== undefined && matches(other, row) && matches(row, other);
        })
    );
}

/** Only canonical site rule mutations gain this workflow; Bonjour profiles and templates remain separate resources. */
export function isMdnsWrite(operation: ApiOperation): boolean {
    return (
        (operation.method === 'POST' && operation.path === MDNS_PATH) ||
        (['PATCH', 'DELETE'].includes(operation.method) && operation.path === `${MDNS_PATH}/{mdnsId}`)
    );
}
export function validateMdnsInput(method: string, body: unknown): void {
    if (method === 'DELETE') return;
    (method === 'POST' ? mdnsConfigSchema : mdnsConfigFieldsSchema.partial()).parse(body);
}

/** Complete bounded evidence is required before proving absence or changing an existing rule. */
export async function readMdnsRows(readPage: (page: number) => Promise<unknown>): Promise<MdnsRow[]> {
    const rows: MdnsRow[] = [],
        seen = new Set<string>(),
        pages = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
        const result = await readPage(page),
            bare = Array.isArray(result);
        if ((!bare && (!object(result) || !Array.isArray(result.data))) || (bare && page !== 1))
            throw new Error('mDNS evidence is incomplete: invalid collection envelope');
        const data = bare ? result : (result as { data: unknown[] }).data;
        if (!bare && object(result)) {
            if (result.currentPage !== undefined && result.currentPage !== page) throw new Error('mDNS page did not advance');
            if (result.currentSize !== undefined && (!Number.isSafeInteger(result.currentSize) || result.currentSize !== 100 || data.length > 100))
                throw new Error('mDNS page size is inconsistent');
            if (result.totalRows !== undefined) {
                if (!Number.isSafeInteger(result.totalRows) || Number(result.totalRows) < 0 || (total !== undefined && total !== result.totalRows))
                    throw new Error('mDNS collection count is invalid or changed during reading');
                total = Number(result.totalRows);
            }
        }
        if ((total ?? rows.length + data.length) > 1000 || rows.length + data.length > 1000)
            throw new Error('mDNS collection exceeds the 1000-record limit');
        const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
        if (data.length && pages.has(fingerprint)) throw new Error('mDNS collection repeated a page');
        pages.add(fingerprint);
        for (const value of data) {
            if (!object(value)) throw new Error('mDNS evidence is incomplete: invalid rule');
            const id = value.id ?? value.mdnsId;
            if (
                !dnsChangeIdentifierSchema.safeParse(id).success ||
                (value.id !== undefined && value.mdnsId !== undefined && value.id !== value.mdnsId) ||
                seen.has(String(id))
            )
                throw new Error('mDNS evidence is incomplete: missing, conflicting or duplicate IDs');
            const parsed = mdnsConfigSchema.safeParse(config(value));
            if (!parsed.success) throw new Error('mDNS evidence is incomplete: invalid rule configuration');
            seen.add(String(id));
            rows.push({ ...parsed.data, id: String(id) });
        }
        if (total !== undefined && rows.length > total) throw new Error('mDNS collection exceeds its reported count');
        if (bare || (total !== undefined && rows.length === total)) return rows;
        if (!data.length) {
            if (total !== undefined && rows.length !== total) throw new Error('mDNS collection ended before its reported count');
            return rows;
        }
    }
    throw new Error('mDNS collection exceeds the 10-page limit');
}

async function referenceIds(readPage: (page: number) => Promise<unknown>, paginated: boolean): Promise<Set<string>> {
    const ids = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
        const result = await readPage(page);
        const bare = Array.isArray(result);
        if ((!bare && (!object(result) || !Array.isArray(result.data))) || (bare && page !== 1))
            throw new Error('mDNS reference inventory is incomplete');
        const data = bare ? result : (result as { data: unknown[] }).data;
        if (!bare && object(result)) {
            if (result.currentPage !== undefined && result.currentPage !== page) throw new Error('mDNS reference page did not advance');
            if (result.totalRows !== undefined) {
                if (!Number.isSafeInteger(result.totalRows) || Number(result.totalRows) < 0 || (total !== undefined && total !== result.totalRows))
                    throw new Error('mDNS reference count is invalid or changed');
                total = Number(result.totalRows);
            }
        }
        if ((total ?? ids.size + data.length) > 1000 || ids.size + data.length > 1000)
            throw new Error('mDNS reference inventory exceeds 1000 records');
        for (const value of data) {
            const id = object(value) ? value.id : undefined;
            if (!dnsChangeIdentifierSchema.safeParse(id).success || ids.has(String(id)))
                throw new Error('mDNS reference identity is missing or duplicated');
            ids.add(String(id));
        }
        if (total !== undefined && ids.size > total) throw new Error('mDNS reference count is inconsistent');
        if (!paginated || bare || (total !== undefined && ids.size === total) || data.length === 0) {
            if (total !== undefined && ids.size !== total) throw new Error('mDNS reference inventory ended early');
            return ids;
        }
    }
    throw new Error('mDNS reference inventory exceeds 10 pages');
}

export async function validateMdnsReferences(
    desired: Record<string, unknown>,
    readProfiles: () => Promise<unknown>,
    readNetworks: (page: number) => Promise<unknown>
): Promise<void> {
    const config = mdnsConfigSchema.parse(desired);
    const profiles = await referenceIds(readProfiles, false);
    if (config.profileIds.some((id) => !profiles.has(id))) throw new Error('mDNS references an unavailable Bonjour service profile');
    if (config.type === 1) {
        const networks = await referenceIds(readNetworks, true);
        if ([...config.osg!.serviceNetworks, ...config.osg!.clientNetworks].some((id) => !networks.has(id)))
            throw new Error('mDNS references an unavailable LAN network');
    }
}

/** One mutation with preserving preflight and read-back; uncertain outcomes never replay the write. */
export async function executeMdnsWrite(
    request: RequestHandler,
    method: string,
    path: string,
    targetId: unknown,
    body: unknown,
    readPage: (page: number) => Promise<unknown>,
    validateBody: (body: Record<string, unknown>) => void,
    safety: DnsWriteSafety = {},
    validateReferences?: (desired: Record<string, unknown>) => Promise<void>
): Promise<MdnsWriteResult> {
    const id = method === 'POST' ? undefined : dnsChangeIdentifierSchema.parse(targetId);
    validateMdnsInput(method, body);
    const read = () => readMdnsRows(readPage),
        before = await read(),
        current = before.find((row) => row.id === id);
    if (safety.expected && (!current || current.id !== safety.expected.id || !sameDnsConfig(config(current), safety.expected.config)))
        throw new Error('mDNS rollback target changed; no write was sent');
    const unchanged = (): MdnsWriteResult => ({
        written: false,
        verified: true,
        verification: { status: 'verified', attempts: 0, ...(id ? { resourceId: id } : {}) },
    });
    if (method === 'DELETE' && !current) return unchanged();
    if (method === 'PATCH' && !current) throw new Error('mDNS target does not exist');
    const merged = { ...(current ? config(current) : {}), ...(object(body) ? body : {}) };
    for (const key of ['ap', 'osg']) if (current && object(current[key]) && object(merged[key])) merged[key] = { ...current[key], ...merged[key] };
    const desired = method === 'DELETE' ? undefined : mdnsConfigSchema.parse(merged);
    if (desired) {
        validateBody(desired);
        if (before.some((row) => row.id !== id && String(row.name).toLowerCase() === desired.name.toLowerCase()))
            throw new Error('mDNS name conflicts with an existing rule');
        if (current && matches(current, desired)) return unchanged();
        if (!validateReferences) throw new Error('mDNS reference validation is required before changing a rule');
        await validateReferences(desired);
    }
    if (!sameRows(before, await read())) throw new Error('mDNS changed during preflight; no write was sent');
    let response: unknown,
        result: unknown,
        acknowledged = false;
    try {
        response = await request.request(
            {
                method,
                url: path,
                ...(desired ? { data: desired, headers: { 'Content-Type': 'application/json' } } : {}),
                maxContentLength: 8 * 1024 * 1024,
                maxBodyLength: 1024 * 1024,
            },
            false
        );
    } catch (error) {
        const status = object(error) ? error.status : undefined;
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) throw error;
    }
    if (object(response) && Number.isInteger(response.errorCode)) {
        result = request.ensureSuccess(response as { errorCode: number; result: unknown });
        acknowledged = true;
    }
    const ackId = typeof result === 'string' ? result : object(result) ? (result.id ?? result.mdnsId) : undefined;
    let observed: MdnsRow | undefined;
    const verification = await verifyWrite(read, (rows) => {
        const candidates =
            method === 'POST'
                ? rows.filter((row) => !before.some((old) => old.id === row.id) && String(row.name).toLowerCase() === desired?.name.toLowerCase())
                : rows.filter((row) => row.id === id);
        if (candidates.length > 1) throw new Error('mDNS created identity is ambiguous');
        observed = candidates[0];
        if (
            !sameRows(
                before.filter((row) => row.id !== id),
                rows.filter((row) => row.id !== observed?.id && row.id !== id)
            )
        )
            return false;
        if (method === 'DELETE') return observed === undefined;
        if (!observed) return false;
        if (Object.keys(desired ?? {}).some((field) => observed?.[field] === undefined)) throw new Error('mDNS read-back omits submitted fields');
        return (method !== 'POST' || ackId === undefined || ackId === observed.id) && matches(observed, desired ?? {});
    });
    const verified = verification.status === 'verified';
    const receipt = acknowledged && verified ? dnsChangeReceipt('mdns-rule', safety.scope, current, observed) : undefined;
    return {
        written: acknowledged ? true : 'unknown',
        verified,
        ...(acknowledged ? { result } : {}),
        verification: {
            status: verification.status,
            attempts: verification.attempts,
            ...(observed ? { resourceId: observed.id, observed } : id ? { resourceId: id } : {}),
        },
        ...(receipt
            ? { rollbackReceipt: receipt }
            : acknowledged && verified && safety.scope
              ? { rollbackUnavailable: 'Known configuration field presence cannot be restored safely.' }
              : {}),
        ...(!acknowledged || !verified
            ? {
                  warning:
                      'Inspect mDNS state before retrying. A mutation was sent once; missing acknowledgement remains written:"unknown" even when desired state is observed.',
              }
            : {}),
    };
}
