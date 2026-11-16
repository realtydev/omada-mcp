import { isDeepStrictEqual } from 'node:util';
import type { RequestHandler } from '../omadaClient/request.js';
import { createRequestRedactor, redactedRequestError } from '../utils/redact.js';
import { completeSsidSchema, ssidUpdateSchema } from '../utils/ssid-update-schema.js';
import { verifyWrite } from '../utils/write-verification.js';
import type { ApiOperation } from './catalog.js';

const SITE = '/openapi/v1/{omadacId}/sites/{siteId}';
export const WLAN_PATH = `${SITE}/wireless-network/wlans`;
export const SSID_PATH = `${WLAN_PATH}/{wlanId}/ssids`;
export const POLICY_ROUTE_PATH = `${SITE}/routing/policy-routings`;
type Row = Record<string, unknown> & { id: string };
export type ResourceKind = 'wlan' | 'ssid' | 'policy-route';
export type ResourceRead = (path: string, params?: Record<string, unknown>) => Promise<unknown>;

export function managedResource(
    operation: Pick<ApiOperation, 'method' | 'path'>
): { kind: ResourceKind; listPath: string; idParam: string } | undefined {
    for (const [kind, listPath, idParam, update] of [
        ['wlan', WLAN_PATH, 'wlanId', 'PATCH'],
        ['ssid', SSID_PATH, 'ssidId', ''],
        ['policy-route', POLICY_ROUTE_PATH, 'policyRoutingId', 'PUT'],
    ] as const) {
        if (
            (operation.method === 'POST' && operation.path === listPath) ||
            ([update, 'DELETE'].includes(operation.method) && operation.path === `${listPath}/{${idParam}}`)
        )
            return { kind, listPath, idParam };
    }
    return undefined;
}

/** These writes must not bypass the discovery workflow through the raw API escape hatch. */
export function isManagedResourceWrite(method: string, path: string): boolean {
    return (
        method !== 'GET' &&
        (/\/sites\/[^/]+\/routing\/policy-routings(?:\/[^/]+)?$/.test(path) ||
            /\/sites\/[^/]+\/wireless-network\/wlans(?:\/[^/]+)?$/.test(path) ||
            /\/sites\/[^/]+\/wireless-network\/(?:wlans\/[^/]+\/)?ssids(?:\/[^/]+)?$/.test(path))
    );
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Complete bounded inventory: malformed or repeated pages cannot prove absence. */
export async function readResourceRows(readPage: (page: number) => Promise<unknown>, aliases: string[] = []): Promise<Row[]> {
    const rows: Row[] = [],
        ids = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
        const result = await readPage(page);
        const bare = Array.isArray(result);
        const data = bare ? result : object(result) && Array.isArray(result.data) ? result.data : undefined;
        if (!data || (bare && page !== 1)) throw new Error('Incomplete resource inventory');
        if (!bare && object(result)) {
            if (result.currentPage !== undefined && result.currentPage !== page) throw new Error('Resource page did not advance');
            if (result.totalRows !== undefined) {
                if (!Number.isSafeInteger(result.totalRows) || Number(result.totalRows) < 0 || (total !== undefined && total !== result.totalRows))
                    throw new Error('Resource count changed or is invalid');
                total = Number(result.totalRows);
            }
        }
        if (rows.length + data.length > 1000 || (total ?? 0) > 1000) throw new Error('Resource inventory exceeds 1000 records');
        for (const value of data) {
            if (!object(value)) throw new Error('Invalid resource row');
            const candidates = ['id', ...aliases].filter((key) => value[key] !== undefined).map((key) => value[key]);
            const id = candidates[0];
            if (typeof id !== 'string' || !id || candidates.some((v) => v !== id) || ids.has(id))
                throw new Error('Missing, conflicting or repeated resource identity');
            ids.add(id);
            rows.push({ ...value, id });
        }
        if (total !== undefined && rows.length > total) throw new Error('Resource count exceeded');
        if (bare || (total !== undefined && rows.length === total)) return rows;
        if (!data.length) {
            if (total !== undefined && rows.length !== total) throw new Error('Resource inventory ended early');
            return rows;
        }
    }
    throw new Error('Resource inventory exceeds ten pages');
}

export function validateManagedInput(kind: ResourceKind, method: string, body: unknown): void {
    if (method === 'DELETE') return;
    if (!object(body)) throw new Error('Resource configuration is required');
    if (kind === 'ssid') {
        completeSsidSchema.parse(Object.fromEntries(Object.entries(body).filter(([key]) => Object.hasOwn(ssidUpdateSchema.shape, key))));
    } else if (kind === 'wlan' && method === 'POST' && body.clone !== false) {
        throw new Error('Verified WLAN creation requires clone:false; cloning SSIDs is not supported by this workflow');
    } else if (kind === 'policy-route') {
        for (const key of ['sourceIds', 'destinationIds', 'protocols']) {
            const values = body[key];
            if (!Array.isArray(values) || !values.length || values.length > 1000 || new Set(values).size !== values.length)
                throw new Error(`Policy route requires unique, nonempty ${key}`);
        }
        for (const key of ['sourceType', 'destinationType'])
            if (![0, 1, 2].includes(Number(body[key]))) throw new Error(`Unsupported ${key}; use network, IP group or IP-port group`);
        if (![0, 2, 3, 4].includes(Number(body.interfaceType))) throw new Error('A supported policy route interfaceType is required');
        if (body.interfaceType === 4) {
            if (!['wanPortIds', 'vpnIds', 'virtualWanIds'].some((key) => Array.isArray(body[key]) && body[key].length))
                throw new Error('Multi-interface routing requires at least one WAN, VPN or virtual WAN');
        } else if (typeof body.interfaceId !== 'string' || !body.interfaceId) throw new Error('Policy route interfaceId is required');
    }
}

function subset(actual: unknown, desired: unknown, requireEvidence = true): boolean {
    if (object(desired)) {
        if (!object(actual)) {
            if (requireEvidence) throw new Error('Read-back omits submitted configuration');
            return false;
        }
        return Object.entries(desired).every(([key, value]) => {
            if (!Object.hasOwn(actual, key)) {
                if (requireEvidence) throw new Error('Read-back omits submitted configuration');
                return false;
            }
            return subset(actual[key], value, requireEvidence);
        });
    }
    return isDeepStrictEqual(actual, desired);
}

export async function executeManagedWrite(input: {
    request: RequestHandler;
    operation: ApiOperation;
    path: string;
    params: Record<string, unknown>;
    body: unknown;
    resource: NonNullable<ReturnType<typeof managedResource>>;
    fields: string[];
    read: ResourceRead;
    validateBody: (body: Record<string, unknown>) => void;
}) {
    const { request, operation, path, params, resource, read, validateBody } = input;
    const { kind, listPath, idParam } = resource;
    const method = operation.method;
    const id = method === 'POST' ? undefined : String(params[idParam]);
    const readRows = () => readResourceRows((page) => read(listPath, { ...params, page, pageSize: 100 }), [idParam]);
    const before = await readRows(),
        current = before.find((row) => row.id === id);
    const noOp = () => ({
        written: false as const,
        verified: true,
        verification: { status: 'verified' as const, attempts: 0, ...(id ? { resourceId: id } : {}) },
    });
    if (method === 'DELETE' && !current) return noOp();
    if (method !== 'POST' && !current) throw new Error('Resource target does not exist');
    const config = (row: Record<string, unknown>) =>
        Object.fromEntries(input.fields.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
    const desired = method === 'DELETE' ? undefined : { ...(current ? config(current) : {}), ...(object(input.body) ? input.body : {}) };
    if (desired) {
        validateBody(desired);
        validateManagedInput(kind, method, desired);
        if (typeof desired.name !== 'string' || !desired.name) throw new Error('Resource name is required');
        if (before.some((row) => row.id !== id && String(row.name).toLowerCase() === String(desired.name).toLowerCase()))
            throw new Error('Resource name already exists');
        if (current && subset(current, desired, false)) return noOp();
    }
    if (kind === 'ssid') {
        const groups = await readResourceRows(() => read(WLAN_PATH, params), ['wlanId']);
        if (!groups.some((group) => group.id === params.wlanId)) throw new Error('WLAN group does not exist');
    }
    if (kind === 'wlan' && method === 'DELETE') {
        if (current?.primary !== false) throw new Error('Default or unqualified WLAN groups cannot be deleted');
        const ssids = await readResourceRows((page) => read(SSID_PATH, { ...params, page, pageSize: 100 }), ['ssidId']);
        if (ssids.length) throw new Error('Delete SSIDs explicitly before deleting their WLAN group');
    }
    if (kind === 'policy-route' && desired) {
        for (const side of ['source', 'destination']) {
            const type = Number(desired[`${side}Type`]);
            const referencePath = type === 0 ? `${SITE}/lan-networks` : `${SITE}/profiles/groups/{groupType}`;
            const refs = await readResourceRows((page) => read(referencePath, { ...params, groupType: String(type - 1), page, pageSize: 100 }));
            if ((desired[`${side}Ids`] as string[]).some((ref) => !refs.some((row) => row.id === ref)))
                throw new Error(`Policy route ${side} references an unavailable network/group`);
        }
    }
    const same = (a: Row[], b: Row[]) =>
        a.length === b.length &&
        a.every((row) => {
            const other = b.find((candidate) => candidate.id === row.id);
            return other !== undefined && isDeepStrictEqual(config(row), config(other)) && (kind !== 'wlan' || row.primary === other.primary);
        });
    if (!same(before, await readRows())) throw new Error('Resource configuration changed during preflight; no write was sent');
    const redact = createRequestRedactor(input.body, desired);
    let acknowledged = false,
        result: unknown,
        response: unknown;
    try {
        response = await request.request(
            { method, url: path, ...(desired ? { data: desired } : {}), maxContentLength: 8 * 1024 * 1024, maxBodyLength: 1024 * 1024 },
            false
        );
    } catch (error) {
        // Controller rejections are definitive; lost acknowledgements are reconciled without replay.
        const status = object(error) ? error.status : undefined;
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) throw redactedRequestError(error, redact);
    }
    if (object(response) && Number.isInteger(response.errorCode)) {
        try {
            result = request.ensureSuccess(response as { errorCode: number; result: unknown });
            acknowledged = true;
        } catch (error) {
            throw redactedRequestError(error, redact);
        }
    }
    const ackId = typeof result === 'string' ? result : object(result) ? (result.id ?? result[idParam]) : undefined;
    let resourceId = id;
    const notVerifiedFields: string[] = [];
    function readable(value: unknown, prefix = ''): unknown {
        if (!object(value)) return value;
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => {
                    if (!/password|passwd|secret|^psk$|security.?key|private.?key/i.test(key)) return true;
                    notVerifiedFields.push(`${prefix}${key}`);
                    return false;
                })
                .map(([key, child]) => [key, readable(child, `${prefix}${key}.`)])
        );
    }
    const expected = readable(kind === 'wlan' && desired ? { name: desired.name } : desired);
    const verification = await verifyWrite(
        async () => {
            const rows = await readRows();
            const matches =
                method === 'POST'
                    ? rows.filter((row) => !before.some((old) => old.id === row.id) && row.name === desired?.name)
                    : rows.filter((row) => row.id === id);
            const detail =
                kind === 'ssid' && method === 'POST' && matches.length === 1
                    ? await read(`${SSID_PATH}/{ssidId}`, { ...params, ssidId: matches[0].id })
                    : undefined;
            return { rows, detail };
        },
        ({ rows: asyncRows, detail }) => {
            const candidates =
                method === 'POST'
                    ? asyncRows.filter((row) => !before.some((old) => old.id === row.id) && row.name === desired?.name)
                    : asyncRows.filter((row) => row.id === id);
            if (candidates.length > 1) throw new Error('Created resource identity is ambiguous');
            const observed = candidates[0];
            resourceId = observed?.id ?? id;
            if (
                !same(
                    before.filter((row) => row.id !== id),
                    asyncRows.filter((row) => row.id !== observed?.id && row.id !== id)
                )
            )
                return false;
            if (method === 'DELETE') return !observed;
            if (!observed || (method === 'POST' && ackId !== undefined && ackId !== observed.id)) return false;
            return subset(detail ?? observed, expected);
        }
    );
    const verified = verification.status === 'verified' && notVerifiedFields.length === 0;
    return {
        written: acknowledged ? (true as const) : ('unknown' as const),
        verified,
        verification: {
            status: notVerifiedFields.length && verification.status === 'verified' ? ('unknown' as const) : verification.status,
            attempts: verification.attempts,
            ...(resourceId ? { resourceId } : {}),
        },
        ...(notVerifiedFields.length ? { notVerifiedFields } : {}),
        ...(!acknowledged || !verified
            ? {
                  warning:
                      'Inspect current configuration before retrying. The write was sent once; secret or missing fields and lost acknowledgements cannot establish complete success.',
              }
            : {}),
    };
}
