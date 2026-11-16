import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RequestHandler } from '../omadaClient/request.js';
import {
    type DnsChangeReceipt,
    type DnsWriteSafety,
    dnsChangeIdentifierSchema,
    dnsChangeReceipt,
    lanDnsConfigSchema,
    sameDnsConfig,
} from '../utils/dns-change-schema.js';
import { verifyWrite, type WriteVerification } from '../utils/write-verification.js';
import type { ApiOperation } from './catalog.js';

export const LAN_DNS_PATH = '/openapi/v1/{omadacId}/sites/{siteId}/setting/lan/dns';
const fields = [
    'enable',
    'name',
    'domain',
    'type',
    'aliases',
    'ipAddresses',
    'ipv6Addresses',
    'cname',
    'dnsServers',
    'lanNetworkIds',
    'customTtl',
    'ttl',
] as const;
const identifier = dnsChangeIdentifierSchema;
const rowSchema = lanDnsConfigSchema.safeExtend({ id: identifier.optional(), dnsId: identifier.optional() }).strip();
type Row = Record<string, unknown> & { id: string };
export interface LanDnsWriteResult {
    written: boolean | 'unknown';
    verified: boolean;
    result?: unknown;
    verification: Omit<WriteVerification<Row[]>, 'observed' | 'message'> & { resourceId?: string; observed?: Row };
    warning?: string;
    rollbackReceipt?: DnsChangeReceipt;
    rollbackUnavailable?: string;
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function config(row: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(fields.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
}
function canonical(value: unknown, field = ''): unknown {
    if (Array.isArray(value)) return value.map((item) => canonical(item, field)).sort();
    if (typeof value === 'string' && ['domain', 'cname', 'aliases'].includes(field)) return value.toLowerCase().replace(/\.$/, '');
    return value;
}
function matches(row: Row, desired: Record<string, unknown>): boolean {
    return Object.entries(desired).every(([key, value]) => isDeepStrictEqual(canonical(row[key], key), canonical(value, key)));
}
function sameRows(left: Row[], right: Row[]): boolean {
    return (
        left.length === right.length &&
        left.every((row) => {
            const other = right.find((r) => r.id === row.id);
            return other !== undefined && matches(other, row) && matches(row, other);
        })
    );
}

/** Accept the two observed collection envelopes only; incomplete evidence never proves absence. */
export async function readLanDnsRows(readPage: (page: number) => Promise<unknown>): Promise<Row[]> {
    const rows: Row[] = [],
        seen = new Set<string>(),
        pages = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
        const result = await readPage(page);
        const bare = Array.isArray(result);
        if ((!bare && (!object(result) || !Array.isArray(result.data))) || (bare && page !== 1))
            throw new Error('LAN DNS evidence is incomplete: invalid collection envelope');
        const data = bare ? result : (result as { data: unknown[] }).data;
        if (!bare && object(result)) {
            if (result.currentPage !== undefined && result.currentPage !== page) throw new Error('LAN DNS page did not advance');
            if (result.totalRows !== undefined) {
                if (!Number.isSafeInteger(result.totalRows) || Number(result.totalRows) < 0 || (total !== undefined && total !== result.totalRows))
                    throw new Error('LAN DNS collection count is invalid or changed during reading');
                total = Number(result.totalRows);
            }
        }
        if ((total ?? rows.length + data.length) > 1000 || rows.length + data.length > 1000)
            throw new Error('LAN DNS collection exceeds the 1000-record limit');
        const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
        if (data.length && pages.has(fingerprint)) throw new Error('LAN DNS collection repeated a page');
        pages.add(fingerprint);
        for (const value of data) {
            const parsed = rowSchema.safeParse(value);
            if (!parsed.success) throw new Error('LAN DNS evidence is incomplete: invalid row configuration');
            const row = parsed.data,
                id = row.id ?? row.dnsId;
            if (!id || (row.id !== undefined && row.dnsId !== undefined && row.id !== row.dnsId) || seen.has(id))
                throw new Error('LAN DNS evidence is incomplete: missing, conflicting or duplicate IDs');
            seen.add(id);
            rows.push({ ...config(row), id });
        }
        if (total !== undefined && rows.length > total) throw new Error('LAN DNS collection exceeds its reported count');
        if (bare || (total !== undefined && rows.length === total)) return rows;
        if (!data.length) {
            if (total !== undefined && rows.length !== total) throw new Error('LAN DNS collection ended before its reported count');
            return rows;
        }
    }
    throw new Error('LAN DNS collection exceeds the 10-page limit');
}

export function isLanDnsWrite(operation: ApiOperation): boolean {
    return (
        (operation.method === 'POST' && operation.path === LAN_DNS_PATH) ||
        (['PATCH', 'DELETE'].includes(operation.method) && operation.path === `${LAN_DNS_PATH}/{dnsId}`)
    );
}

/** One mutation, bounded state checks, and no inference that a lost acknowledgement means failure. */
export async function executeLanDnsWrite(
    request: RequestHandler,
    method: string,
    path: string,
    targetId: unknown,
    body: unknown,
    readPage: (page: number) => Promise<unknown>,
    validateBody: (body: Record<string, unknown>) => void,
    safety: DnsWriteSafety = {}
): Promise<LanDnsWriteResult> {
    const id = method === 'POST' ? undefined : identifier.parse(targetId);
    if (object(body) && body.id !== undefined && (id === undefined || body.id !== id)) throw new Error('LAN DNS body ID must match the target');
    if (object(body) && Object.keys(body).some((key) => key !== 'id' && !fields.some((field) => field === key)))
        throw new Error('LAN DNS read-back does not support a submitted field; no write was sent');
    const read = () => readLanDnsRows(readPage);
    const before = await read();
    const current = before.find((row) => row.id === id);
    if (safety.expected && (!current || current.id !== safety.expected.id || !sameDnsConfig(config(current), safety.expected.config)))
        throw new Error('Rollback refused: LAN DNS changed while preparing restoration');
    const unchanged = (resourceId = id): LanDnsWriteResult => ({
        written: false,
        verified: true,
        verification: { status: 'verified', attempts: 0, ...(resourceId ? { resourceId } : {}) },
    });
    if (method === 'DELETE' && !current) return unchanged();
    if (method === 'PATCH' && !current) throw new Error('LAN DNS target does not exist');
    const desired = method === 'DELETE' ? undefined : { ...(current ? config(current) : {}), ...config(object(body) ? body : {}) };
    if (desired) {
        if (current && current.type !== desired.type)
            throw new Error('LAN DNS record-type changes are not supported by the verified preserving workflow');
        validateBody(desired);
        const conflict = before.some(
            (row) =>
                row.id !== id &&
                (String(row.name).toLowerCase() === String(desired.name).toLowerCase() ||
                    canonical(row.domain, 'domain') === canonical(desired.domain, 'domain'))
        );
        if (conflict) throw new Error('LAN DNS name or domain conflicts with an existing entry');
        if (current && matches(current, desired)) return unchanged();
    }
    if (!sameRows(before, await read())) throw new Error('LAN DNS changed during preflight; no write was sent');
    let response: unknown,
        acknowledged = false,
        result: unknown;
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
    const ackId = typeof result === 'string' ? result : object(result) ? (result.id ?? result.dnsId) : undefined;
    let observed: Row | undefined;
    const verification = await verifyWrite(read, (rows) => {
        const candidates =
            method === 'POST'
                ? rows.filter(
                      (row) => !before.some((old) => old.id === row.id) && canonical(row.domain, 'domain') === canonical(desired?.domain, 'domain')
                  )
                : rows.filter((row) => row.id === id);
        if (candidates.length > 1) throw new Error('LAN DNS created identity is ambiguous');
        observed = candidates[0];
        const others = rows.filter((row) => row.id !== observed?.id && row.id !== id);
        if (
            !sameRows(
                before.filter((row) => row.id !== id),
                others
            )
        )
            return false;
        if (method === 'DELETE') return observed === undefined;
        if (!observed) return false;
        if (Object.keys(desired ?? {}).some((field) => observed?.[field] === undefined)) throw new Error('LAN DNS read-back omits submitted fields');
        return (method !== 'POST' || ackId === undefined || ackId === observed.id) && matches(observed, desired ?? {});
    });
    const verified = verification.status === 'verified';
    const receipt = acknowledged && verified ? dnsChangeReceipt('lan-dns', safety.scope, current, observed) : undefined;
    return {
        written: acknowledged ? true : 'unknown',
        verified,
        ...(receipt
            ? { rollbackReceipt: receipt }
            : safety.scope && verified && acknowledged
              ? { rollbackUnavailable: 'DNS field presence cannot be safely restored from this change.' }
              : {}),
        ...(acknowledged ? { result } : {}),
        verification: {
            status: verification.status,
            attempts: verification.attempts,
            ...(observed ? { resourceId: observed.id, observed } : id ? { resourceId: id } : {}),
        },
        ...(!acknowledged || !verified
            ? {
                  warning:
                      'Inspect LAN DNS state before retrying. A mutation was sent once; missing acknowledgement remains written:"unknown" even when the desired state is observed.',
              }
            : {}),
    };
}
