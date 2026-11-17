import { isIP } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import type { RequestHandler } from '../omadaClient/request.js';
import { createRequestRedactor, redactedRequestError } from '../utils/redact.js';
import { completeSsidSchema, ssidUpdateSchema } from '../utils/ssid-update-schema.js';
import { normalizeMac, validateSwitchMac } from '../utils/switch-port-safety.js';
import { verifyWrite } from '../utils/write-verification.js';
import type { ApiOperation } from './catalog.js';
import { type ResourceRead, type ResourceRow as Row, readResourceRows } from './resourceInventory.js';
import {
    comparableSiteToSite,
    readSiteToSiteVpns,
    SITE_TO_SITE_PATH,
    type SiteToSiteKind,
    siteToSiteConfig,
    VPN_DELETE_PATH,
    validateSiteToSiteCapabilities,
    validateSiteToSiteInput,
    validateSiteToSiteReferences,
} from './siteToSiteVpn.js';
import { validateWireguard } from './wireguard.js';

const SITE = '/openapi/v1/{omadacId}/sites/{siteId}';
export const WLAN_PATH = `${SITE}/wireless-network/wlans`;
export const SSID_PATH = `${WLAN_PATH}/{wlanId}/ssids`;
export const POLICY_ROUTE_PATH = `${SITE}/routing/policy-routings`;
const POE_SCHEDULE_PATH = `${SITE}/poe-schedules`;
const WIREGUARD_PATH = `${SITE}/vpn/wireguards`;
const WIREGUARD_PEER_PATH = `${SITE}/vpn/wireguard-peers`;
export type ResourceKind = 'wlan' | 'ssid' | 'policy-route' | 'poe-schedule' | 'wireguard' | 'wireguard-peer' | SiteToSiteKind;

export function managedResource(
    operation: Pick<ApiOperation, 'method' | 'path'>
): { kind: ResourceKind; listPath: string; idParam: string } | undefined {
    if (operation.method === 'DELETE' && operation.path === VPN_DELETE_PATH)
        return { kind: 'vpn-delete', listPath: SITE_TO_SITE_PATH, idParam: 'vpnId' };
    for (const [kind, path] of [
        ['vpn-manual', SITE_TO_SITE_PATH],
        ['vpn-auto', `${SITE_TO_SITE_PATH}/auto`],
    ] as const)
        if ((operation.method === 'POST' && operation.path === path) || (operation.method === 'PATCH' && operation.path === `${path}/{vpnId}`))
            return { kind, listPath: SITE_TO_SITE_PATH, idParam: 'vpnId' };
    for (const [kind, listPath, idParam, update] of [
        ['wlan', WLAN_PATH, 'wlanId', 'PATCH'],
        ['ssid', SSID_PATH, 'ssidId', ''],
        ['policy-route', POLICY_ROUTE_PATH, 'policyRoutingId', 'PUT'],
        ['poe-schedule', POE_SCHEDULE_PATH, 'poeScheduleId', 'PUT'],
        ['wireguard', WIREGUARD_PATH, 'id', 'PUT'],
        ['wireguard-peer', WIREGUARD_PEER_PATH, 'id', 'PUT'],
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
        (/\/sites\/[^/]+\/poe-schedules(?:\/[^/]+)?\/?$/.test(path) ||
            /\/sites\/[^/]+\/vpn\/site-to-site-vpns(?:\/[^/]+){0,2}\/?$/.test(path) ||
            (method === 'DELETE' && /\/sites\/[^/]+\/vpn\/[^/]+\/?$/.test(path)) ||
            /\/sites\/[^/]+\/vpn\/(?:wireguards|wireguard-peers)(?:\/[^/]+)?\/?$/.test(path) ||
            /\/sites\/[^/]+\/routing\/policy-routings(?:\/[^/]+)?$/.test(path) ||
            /\/sites\/[^/]+\/wireless-network\/wlans(?:\/[^/]+)?$/.test(path) ||
            /\/sites\/[^/]+\/wireless-network\/(?:wlans\/[^/]+\/)?ssids(?:\/[^/]+)?$/.test(path))
    );
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function poePorts(value: unknown): Record<string, number[]> {
    if (!object(value) || !Object.keys(value).length || Object.keys(value).length > 1000)
        throw new Error('PoE schedule requires a bounded, nonempty device-to-port map');
    const ports: Record<string, number[]> = {};
    let count = 0;
    for (const [mac, selected] of Object.entries(value)) {
        validateSwitchMac(mac);
        const key = normalizeMac(mac);
        if (Object.hasOwn(ports, key)) throw new Error('PoE schedule contains duplicate device MAC identities');
        if (
            !Array.isArray(selected) ||
            !selected.length ||
            selected.some((port) => !Number.isSafeInteger(port) || port < 1 || port > 65535) ||
            new Set(selected).size !== selected.length
        )
            throw new Error('PoE schedule ports must be nonempty, unique positive port numbers');
        count += selected.length;
        if (count > 1000) throw new Error('PoE schedule exceeds 1000 selected ports');
        ports[key] = [...selected].sort((a, b) => a - b);
    }
    return ports;
}

export function validateManagedInput(kind: ResourceKind, method: string, body: unknown, siteId?: unknown): void {
    if (method === 'DELETE') return;
    if (!object(body)) throw new Error('Resource configuration is required');
    if (kind === 'vpn-manual' || kind === 'vpn-auto' || kind === 'vpn-delete') {
        validateSiteToSiteInput(kind, body, siteId);
    } else if (kind === 'wireguard' || kind === 'wireguard-peer') {
        validateWireguard(kind, body);
    } else if (kind === 'ssid') {
        completeSsidSchema.parse(Object.fromEntries(Object.entries(body).filter(([key]) => Object.hasOwn(ssidUpdateSchema.shape, key))));
    } else if (kind === 'wlan' && method === 'POST' && body.clone !== false) {
        throw new Error('Verified WLAN creation requires clone:false; cloning SSIDs is not supported by this workflow');
    } else if (kind === 'poe-schedule') {
        if (typeof body.turnOnTime !== 'string' || !body.turnOnTime.trim()) throw new Error('PoE schedule requires a time-range profile ID');
        if (body.siteId !== undefined && body.siteId !== siteId) throw new Error('PoE schedule body must match the selected site');
        poePorts(body.poePortsMap);
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
    if (Array.isArray(desired)) {
        if (!Array.isArray(actual)) {
            if (requireEvidence) throw new Error('Read-back omits submitted configuration');
            return false;
        }
        return actual.length === desired.length && desired.every((value, index) => subset(actual[index], value, requireEvidence));
    }
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
    const siteToSite = kind === 'vpn-manual' || kind === 'vpn-auto' || kind === 'vpn-delete';
    let vpnCapabilities: Record<string, unknown> = {};
    let peerDomainSupport = false;
    const readRows = async () => {
        if (siteToSite) {
            const snapshot = await readSiteToSiteVpns(read, params);
            vpnCapabilities = snapshot.capabilities;
            return snapshot.rows;
        }
        const rows = await readResourceRows(
            async (page) => {
                const result = await read(listPath, { ...params, page, pageSize: 100 });
                if (kind === 'wireguard-peer' && page === 1) peerDomainSupport = object(result) && result.supportDomain === true;
                return result;
            },
            [idParam]
        );
        if (kind === 'poe-schedule' && rows.some((row) => row.siteId !== undefined && row.siteId !== params.siteId))
            throw new Error('PoE schedule inventory identifies another site');
        return rows;
    };
    const before = await readRows(),
        current = before.find((row) => row.id === id);
    if (siteToSite && method !== 'POST') {
        if (!current || (current.vpnType !== 2 && current.vpnType !== 4) || (current.siteVpnType !== 0 && current.siteVpnType !== 1))
            throw new Error('Target is not a qualified site-to-site IPSec or WireGuard VPN; no deletion or update was sent');
        if (
            kind !== 'vpn-delete' &&
            (current.siteVpnType !== (kind === 'vpn-auto' ? 0 : 1) || !object(input.body) || current.vpnType !== input.body.vpnType)
        )
            throw new Error('Changing VPN protocol or automatic/manual mode requires an explicit replacement');
        if (kind === 'vpn-auto' && object(input.body) && current.remoteSite !== input.body.remoteSite)
            throw new Error('Changing the automatic remote site requires an explicit replacement');
    }
    const notVerifiedFields: string[] = [];
    function readable(value: unknown, prefix = ''): unknown {
        if (Array.isArray(value)) return value.map((child, index) => readable(child, `${prefix}${index}.`));
        if (!object(value)) return value;
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key, child]) => {
                    if (/^presharedKey$/i.test(key) && child === '') return true;
                    if (!/password|passwd|secret|^psk$|preshared.?key|security.?key|private.?key/i.test(key)) return true;
                    notVerifiedFields.push(`${prefix}${key}`);
                    return false;
                })
                .map(([key, child]) => [key, readable(child, `${prefix}${key}.`)])
        );
    }
    if (siteToSite && (kind === 'vpn-auto' || current?.siteVpnType === 0)) notVerifiedFields.push('remoteSiteConfiguration');
    const noOp = () => ({
        written: false as const,
        verified: notVerifiedFields.length === 0,
        verification: {
            status: notVerifiedFields.length ? ('unknown' as const) : ('verified' as const),
            attempts: 0,
            ...(id ? { resourceId: id } : {}),
        },
        ...(notVerifiedFields.length ? { notVerifiedFields } : {}),
    });
    if (method === 'DELETE' && !current) return noOp();
    if (method !== 'POST' && !current) throw new Error('Resource target does not exist');
    const config = (row: Record<string, unknown>) =>
        siteToSite ? siteToSiteConfig(row) : Object.fromEntries(input.fields.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
    const comparable = (value: Record<string, unknown>) =>
        siteToSite
            ? comparableSiteToSite(value)
            : kind === 'poe-schedule' && value.poePortsMap !== undefined
              ? { ...value, poePortsMap: Object.entries(poePorts(value.poePortsMap)).sort(([a], [b]) => a.localeCompare(b)) }
              : kind === 'wireguard-peer' && Array.isArray(value.allowAddress)
                ? { ...value, allowAddress: [...value.allowAddress].sort() }
                : value;
    const desired = method === 'DELETE' ? undefined : { ...(current ? config(current) : {}), ...(object(input.body) ? input.body : {}) };
    if (kind === 'wireguard-peer' && desired?.endPoint === '') delete desired.endPointPort;
    if (siteToSite && desired) {
        if (desired.networkType === 0) delete desired.customNetwork;
        if (desired.networkType === 1) delete desired.networkList;
        if (desired.existCustomNetwork !== undefined) desired.existCustomNetwork = desired.networkType === 1;
        for (const field of ['advancedSetting', 'failoverSetting'])
            if (object(current?.[field]) && object(desired[field])) desired[field] = { ...current[field], ...desired[field] };
    }
    const expected = readable(kind === 'wlan' && desired ? { name: desired.name } : desired ? comparable(desired) : undefined);
    if (desired) {
        validateBody(desired);
        validateManagedInput(kind, method, desired, params.siteId);
        if (typeof desired.name !== 'string' || !desired.name) throw new Error('Resource name is required');
        if (before.some((row) => row.id !== id && String(row.name).toLowerCase() === String(desired.name).toLowerCase()))
            throw new Error('Resource name already exists');
        if (current && subset(comparable(current), comparable(desired), false)) return noOp();
    }
    const disableOnly =
        current && desired?.status === false && isDeepStrictEqual(comparable({ ...config(current), status: false }), comparable(desired));
    if (siteToSite && desired && !disableOnly) {
        if (
            Array.isArray(current?.featureDescription) &&
            current.featureDescription.some((feature) => !object(feature) || feature.featureState !== 0 || feature.changeable === false)
        )
            throw new Error('VPN feature is unsupported or not changeable');
        await validateSiteToSiteReferences(desired, kind === 'vpn-auto', before, id, read, params);
    }
    if (kind === 'vpn-delete' && current?.siteVpnType === 1 && current.vpnType === 4 && (!Array.isArray(current.peers) || current.peers.length))
        throw new Error('Remove WireGuard peers explicitly before deleting their VPN');
    if (kind === 'ssid') {
        const groups = await readResourceRows(() => read(WLAN_PATH, params), ['wlanId']);
        if (!groups.some((group) => group.id === params.wlanId)) throw new Error('WLAN group does not exist');
    }
    if (kind === 'wlan' && method === 'DELETE') {
        if (current?.primary !== false) throw new Error('Default or unqualified WLAN groups cannot be deleted');
        const ssids = await readResourceRows((page) => read(SSID_PATH, { ...params, page, pageSize: 100 }), ['ssidId']);
        if (ssids.length) throw new Error('Delete SSIDs explicitly before deleting their WLAN group');
    }
    if (kind === 'wireguard' && method === 'DELETE') {
        const peers = await readResourceRows((page) => read(WIREGUARD_PEER_PATH, { ...params, page, pageSize: 100 }));
        if (peers.some((peer) => typeof peer.interfaceId !== 'string' || !peer.interfaceId || peer.interfaceId === id))
            throw new Error('Delete referenced WireGuard peers explicitly before deleting their interface; unknown references cannot prove safety');
    }
    if (
        kind === 'wireguard' &&
        desired &&
        before.some((row) => row.id !== id && (row.listenPort === desired.listenPort || row.localIp === desired.localIp))
    )
        throw new Error('WireGuard interface address or listen port is already in use');
    if (kind === 'wireguard-peer' && desired) {
        if (!disableOnly) {
            const interfaces = await readResourceRows((page) => read(WIREGUARD_PATH, { ...params, page, pageSize: 100 }));
            if (!interfaces.some((row) => row.id === desired.interfaceId)) throw new Error('WireGuard interface does not exist');
        }
        if (before.some((row) => row.id !== id && row.interfaceId === desired.interfaceId && row.publicKey === desired.publicKey))
            throw new Error('WireGuard peer public key already exists on this interface');
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
    if (kind === 'poe-schedule' && desired && !disableOnly) {
        const profiles = await readResourceRows(() => read(`${SITE}/time-range-profiles`, params), ['profileId']);
        if (!profiles.some((profile) => profile.id === desired.turnOnTime)) throw new Error('PoE schedule time-range profile does not exist');
        const selected = poePorts(desired.poePortsMap);
        const devices = await read(`${SITE}/poe-ports`, params);
        if (!Array.isArray(devices) || devices.length > 1000) throw new Error('PoE-capable device inventory is unavailable or exceeds its bound');
        const seen = new Set<string>();
        for (const device of devices) {
            if (!object(device) || typeof device.mac !== 'string') throw new Error('PoE device identity is missing');
            validateSwitchMac(device.mac);
            const mac = normalizeMac(device.mac);
            if (seen.has(mac)) throw new Error('PoE device identity is ambiguous');
            seen.add(mac);
            if (!Object.hasOwn(selected, mac)) continue;
            if ((device.site !== undefined && device.site !== params.siteId) || !['switch', 'gateway'].includes(String(device.type)))
                throw new Error('PoE target device has an unqualified site or type');
            const supported = object(device.poePort) ? device.poePort.poePortIds : undefined;
            if (
                !Array.isArray(supported) ||
                supported.length > 1000 ||
                supported.some((port) => !Number.isSafeInteger(port) || port < 1) ||
                new Set(supported).size !== supported.length ||
                selected[mac].some((port) => !supported.includes(port))
            )
                throw new Error('Every selected port must have explicit PoE support in the controller inventory');
        }
        if (Object.keys(selected).some((mac) => !seen.has(mac))) throw new Error('PoE schedule targets an unavailable device');
        if (desired.status === true) {
            for (const row of before.filter((row) => row.id !== id)) {
                if (typeof row.status !== 'boolean') throw new Error('Existing PoE schedule status is unknown');
                if (!row.status) continue;
                const assigned = poePorts(row.poePortsMap);
                if (Object.entries(selected).some(([mac, ports]) => ports.some((port) => assigned[mac]?.includes(port))))
                    throw new Error('A selected port already belongs to another enabled PoE schedule');
            }
        }
    }
    const same = (a: Row[], b: Row[]) =>
        a.length === b.length &&
        a.every((row) => {
            const other = b.find((candidate) => candidate.id === row.id);
            return (
                other !== undefined &&
                isDeepStrictEqual(comparable(config(row)), comparable(config(other))) &&
                (!siteToSite || (row.siteVpnType === other.siteVpnType && row.vpnType === other.vpnType)) &&
                (kind !== 'wlan' || row.primary === other.primary)
            );
        });
    if (!same(before, await readRows())) throw new Error('Resource configuration changed during preflight; no write was sent');
    if (siteToSite && desired && !disableOnly) validateSiteToSiteCapabilities(desired, kind === 'vpn-auto', vpnCapabilities);
    if (
        kind === 'wireguard-peer' &&
        !disableOnly &&
        typeof desired?.endPoint === 'string' &&
        desired.endPoint &&
        !isIP(desired.endPoint) &&
        !peerDomainSupport
    )
        throw new Error('Controller has not advertised WireGuard peer domain endpoint support');
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
            if (siteToSite && (observed.siteVpnType !== (kind === 'vpn-auto' ? 0 : 1) || observed.vpnType !== desired?.vpnType)) return false;
            return subset(siteToSite || kind === 'poe-schedule' || kind === 'wireguard-peer' ? comparable(observed) : (detail ?? observed), expected);
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
                      'Inspect current configuration before retrying. The write was sent once; secrets, missing fields, remote-site provisioning and lost acknowledgements cannot establish complete success.',
              }
            : {}),
    };
}
