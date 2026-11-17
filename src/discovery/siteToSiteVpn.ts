import { isIP } from 'node:net';
import { z } from 'zod';
import type { ApiOperation } from './catalog.js';
import { type ResourceRead, type ResourceRow, readResourceRows } from './resourceInventory.js';
import { vpnCidr, vpnEndpoint, wireguardKey } from './wireguard.js';

const SITE = '/openapi/v1/{omadacId}/sites/{siteId}';
export const SITE_TO_SITE_PATH = '/openapi/v2/{omadacId}/sites/{siteId}/vpn/site-to-site-vpns';
export const VPN_DELETE_PATH = '/openapi/v2/{omadacId}/sites/{siteId}/vpn/{vpnId}';
export type SiteToSiteKind = 'vpn-manual' | 'vpn-auto' | 'vpn-delete';
const base = { name: z.string().regex(/^[a-zA-Z0-9_]{1,63}$/), status: z.boolean() };
const ipv4 = z.string().refine((value) => isIP(value) === 4, 'Expected an IPv4 address');
const port = z.number().int().min(1).max(65535);
const ids = z
    .array(z.string().min(1))
    .min(1)
    .max(1000)
    .refine((values) => new Set(values).size === values.length, 'IDs must be unique');
const subnets = z
    .array(vpnCidr)
    .min(1)
    .max(1000)
    .refine((values) => new Set(values.map((v) => v.toLowerCase())).size === values.length, 'Subnets must be unique');

const localNetworks = {
    networkType: z.union([z.literal(0), z.literal(1)]).optional(),
    networkList: ids.optional(),
    customNetwork: z
        .array(z.object({ ip: ipv4, mask: z.number().int().min(0).max(32) }).strict())
        .min(1)
        .max(1000)
        .optional(),
    existCustomNetwork: z.boolean().optional(),
};
const peer = z
    .object({
        name: z.string().min(1).max(64),
        status: z.boolean(),
        serverPublicKey: wireguardKey,
        remoteIp: vpnEndpoint.optional(),
        servicePort: port.optional(),
        preSharedKey: z.union([z.literal(''), wireguardKey]),
        remoteSubnet: subnets,
        keepAlive: z.number().int().min(0).max(65535),
        comment: z.string().max(128).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (Boolean(value.remoteIp) !== (value.servicePort !== undefined))
            ctx.addIssue({ code: 'custom', path: ['remoteIp'], message: 'Supply peer remoteIp and servicePort together' });
    });
const wireguard = z
    .object({
        ...base,
        vpnType: z.literal(4),
        mtu: z.number().int().min(576).max(1440),
        servicePort: port,
        tunnelIp: ipv4,
        privateKey: wireguardKey,
        peers: z
            .array(peer)
            .max(100)
            .refine(
                (values) =>
                    new Set(values.map((v) => v.serverPublicKey)).size === values.length &&
                    new Set(values.map((v) => v.name.toLowerCase())).size === values.length,
                'Peer names and public keys must be unique'
            ),
        ...localNetworks,
    })
    .strict();
const advanced = z
    .object({
        keyExchangeVersion: z.number().int().min(0).max(1).optional(),
        phase1Proposal1: z.number().int().min(0).max(4).optional(),
        phase1Proposal2: z.number().int().min(0).max(4).optional(),
        phase1Proposal3: z.number().int().min(0).max(10).optional(),
        exchangeMode: z.number().int().min(0).max(1).optional(),
        negotiationMode: z.number().int().min(0).max(1).optional(),
        localIdType: z.number().int().min(0).max(1).optional(),
        localName: z.string().optional(),
        remoteIdType: z.number().int().min(0).max(1).optional(),
        remoteName: z.string().optional(),
        saLifetime: z.number().int().min(60).max(604800).optional(),
        dpd: z.boolean().optional(),
        dpdInterval: z.number().int().min(1).max(300).optional(),
        encapsulationMode: z.number().int().min(0).max(1).optional(),
        phase2Proposal1: z.number().int().min(0).max(1).optional(),
        phase2Proposal2: z.number().int().min(0).max(4).optional(),
        phase2Proposal3: z.number().int().min(0).max(4).optional(),
        pfs: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(14), z.literal(15)]).optional(),
        saLifetime2: z.number().int().min(120).max(604800).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.dpd && value.dpdInterval === undefined)
            ctx.addIssue({ code: 'custom', path: ['dpdInterval'], message: 'DPD requires an interval' });
        for (const side of ['local', 'remote'] as const)
            if (value[`${side}IdType`] === 1 && !value[`${side}Name`]?.trim())
                ctx.addIssue({ code: 'custom', path: [`${side}Name`], message: 'Name identity requires a name' });
    });
const failover = z
    .object({
        failover: z.boolean(),
        backupWan: z.string().min(1).optional(),
        failback: z.boolean().optional(),
        failbackTime: z.number().int().min(10).max(3600).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.failover && (!value.backupWan || value.failback === undefined || (value.failback && value.failbackTime === undefined)))
            ctx.addIssue({ code: 'custom', message: 'Failover requires backupWan, failback and a time when failback is enabled' });
    });
const ipsec = z
    .object({
        ...base,
        vpnType: z.literal(2),
        wans: ids,
        remoteIp: vpnEndpoint,
        remoteSubnet: subnets,
        preSharedKey: z
            .string()
            .min(1)
            .regex(/^[\x21-\x7e]+$/)
            .refine((v) => !/^\*+$/.test(v) && v !== '[redacted]', 'Supply an explicit unmasked IPSec key'),
        ...localNetworks,
        networkType: z.union([z.literal(0), z.literal(1)]),
        advancedSetting: advanced,
        failoverSetting: failover.optional(),
    })
    .strict();
const automatic = z.object({ ...base, vpnType: z.union([z.literal(2), z.literal(4)]), remoteSite: z.string().min(1) }).strict();

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The vendor manual schema combines two disjoint families' required fields. Keep its property constraints. */
export function siteToSiteRequestSchema(operation: Pick<ApiOperation, 'method' | 'path'>, schema: Record<string, unknown>): Record<string, unknown> {
    if (
        !['POST', 'PATCH'].includes(operation.method) ||
        ![SITE_TO_SITE_PATH, `${SITE_TO_SITE_PATH}/{vpnId}`].includes(operation.path) ||
        !object(schema.properties) ||
        !schema.properties.peers ||
        !schema.properties.advancedSetting ||
        !Array.isArray(schema.required)
    )
        return schema;
    const wg = ['mtu', 'privateKey', 'servicePort', 'tunnelIp'];
    const ip = ['wans', 'remoteIp', 'remoteSubnet', 'preSharedKey', 'advancedSetting'];
    if (![...wg, ...ip].every((key) => (schema.required as unknown[]).includes(key))) return schema;
    return {
        ...schema,
        required: schema.required.filter((key) => ![...wg, ...ip].includes(String(key))),
        allOf: [
            ...(Array.isArray(schema.allOf) ? schema.allOf : []),
            {
                if: { properties: { vpnType: { const: 4 } }, required: ['vpnType'] },
                then: { required: [...wg, 'peers'] },
                else: { required: ip },
            },
        ],
    };
}

export function validateSiteToSiteInput(kind: SiteToSiteKind, body: unknown, siteId: unknown): void {
    if (kind === 'vpn-delete') return;
    if (kind === 'vpn-auto') {
        const value = automatic.parse(body);
        if (value.remoteSite === siteId) throw new Error('Automatic VPN requires a different remote site');
        return;
    }
    const value = z.discriminatedUnion('vpnType', [wireguard, ipsec]).parse(body);
    if (value.networkType === 0 && (!value.networkList?.length || value.customNetwork !== undefined))
        throw new Error('Network-list mode requires networkList only');
    if (value.networkType === 1 && (!value.customNetwork?.length || value.networkList !== undefined))
        throw new Error('Custom-network mode requires customNetwork only');
    if (
        value.networkType === undefined &&
        (value.networkList !== undefined || value.customNetwork !== undefined || value.existCustomNetwork !== undefined)
    )
        throw new Error('Local network selection requires networkType');
    if (value.existCustomNetwork !== undefined && value.existCustomNetwork !== (value.networkType === 1))
        throw new Error('Conflicting custom-network selector');
    if (value.customNetwork && new Set(value.customNetwork.map((n) => `${n.ip}/${n.mask}`)).size !== value.customNetwork.length)
        throw new Error('Custom networks must be unique');
    if (value.vpnType === 2 && value.failoverSetting?.failover && value.wans.includes(value.failoverSetting.backupWan ?? ''))
        throw new Error('Failover WAN must differ from the primary WAN selection');
}

/** Writable fields only; firmware metadata and inactive protocol defaults must never enter PATCH requests. */
export function siteToSiteConfig(row: Record<string, unknown>): Record<string, unknown> {
    const schema = row.siteVpnType === 0 ? automatic : row.vpnType === 4 ? wireguard : ipsec;
    return Object.fromEntries(
        Object.keys(schema.shape)
            .filter(
                (key) =>
                    row[key] !== undefined && !(key === 'networkList' && row.networkType === 1) && !(key === 'customNetwork' && row.networkType === 0)
            )
            .map((key) => [key, row[key]])
    );
}

export function comparableSiteToSite(value: Record<string, unknown>): Record<string, unknown> {
    const result = { ...value };
    for (const key of ['remoteSubnet', 'networkList', 'wans']) if (Array.isArray(result[key])) result[key] = [...result[key]].sort();
    if (Array.isArray(result.customNetwork))
        result.customNetwork = [...result.customNetwork].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (Array.isArray(result.peers))
        result.peers = result.peers
            .map((peer) => (object(peer) ? comparableSiteToSite(peer) : peer))
            .sort((a, b) => String(a?.serverPublicKey).localeCompare(String(b?.serverPublicKey)));
    return result;
}

export async function readSiteToSiteVpns(read: ResourceRead, params: Record<string, unknown>) {
    let capabilities: Record<string, unknown> = {};
    const rows = await readResourceRows(async (page) => {
        const result = await read(SITE_TO_SITE_PATH, { ...params, page, pageSize: 100 });
        if (page === 1 && object(result)) capabilities = result;
        return result;
    });
    if (rows.length > 100) throw new Error('Site-to-site detail inventory exceeds 100 VPNs');
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const detail = await read(`${SITE_TO_SITE_PATH}/{vpnId}`, { ...params, vpnId: row.id });
        if (
            !object(detail) ||
            ['id', 'name', 'status', 'vpnType', 'siteVpnType'].some((key) => detail[key] === undefined || detail[key] !== row[key])
        )
            throw new Error('Site-to-site summary and detail identities disagree');
        rows[index] = { ...detail, id: row.id };
    }
    return { rows, capabilities };
}

export function validateSiteToSiteCapabilities(value: Record<string, unknown>, auto: boolean, capabilities: Record<string, unknown>): void {
    const requireFlag = (flag: string) => {
        if (capabilities[flag] !== true) throw new Error(`Controller has not advertised ${flag}`);
    };
    if (value.vpnType === 2) requireFlag('supportIPsec');
    if (auto && value.vpnType === 4) requireFlag('supportAutoWireGuard');
    if (auto) return;
    if (value.vpnType === 4 && value.networkType !== undefined) requireFlag('supportManualWgLocalNetwork');
    if (value.networkType === 1) requireFlag('supportCustomNetwork');
    if (object(value.failoverSetting) && value.failoverSetting.failover) requireFlag('supportIPsecFailover');
    const peers = Array.isArray(value.peers) ? value.peers : [];
    if (peers.some((peer) => object(peer) && typeof peer.remoteIp === 'string' && peer.remoteIp && !isIP(peer.remoteIp)))
        requireFlag('supportWgDomain');
    for (const [field, lists] of [
        ['wgPeerLimitSize', [peers]],
        [
            'subnetsLimitSize',
            [value.remoteSubnet, value.networkList, value.customNetwork, ...peers.map((p) => (object(p) ? p.remoteSubnet : undefined))],
        ],
    ] as const) {
        if (capabilities[field] === undefined) continue;
        if (
            !Number.isSafeInteger(capabilities[field]) ||
            Number(capabilities[field]) < 0 ||
            lists.some((v) => Array.isArray(v) && v.length > Number(capabilities[field]))
        )
            throw new Error(`Configuration exceeds or cannot qualify ${field}`);
    }
    if (object(value.advancedSetting)) {
        for (const [field, cap] of [
            ['phase1Proposal1', 'phase1Proposal1Cap'],
            ['phase2Proposal2', 'phase2Proposal2Cap'],
            ['pfs', 'pfsCap'],
        ]) {
            const selected = value.advancedSetting[field];
            if (selected === undefined || (field === 'pfs' && selected === 0) || capabilities[cap] === undefined) continue;
            if (!Array.isArray(capabilities[cap]) || !capabilities[cap].includes(selected))
                throw new Error(`Controller does not advertise selected ${field}`);
        }
    }
}

export async function validateSiteToSiteReferences(
    value: Record<string, unknown>,
    auto: boolean,
    rows: ResourceRow[],
    id: string | undefined,
    read: ResourceRead,
    params: Record<string, unknown>
): Promise<void> {
    if (auto) {
        const sites = await readResourceRows((page) => read('/openapi/v1/{omadacId}/sites', { page, pageSize: 100 }), ['siteId']);
        if (![params.siteId, value.remoteSite].every((site) => sites.some((row) => row.id === site)))
            throw new Error('Both automatic VPN sites must exist');
        if (rows.some((row) => row.id !== id && row.siteVpnType === 0 && row.vpnType === value.vpnType && row.remoteSite === value.remoteSite))
            throw new Error('Automatic VPN already connects these sites');
        const remote = await readSiteToSiteVpns(read, { ...params, siteId: value.remoteSite });
        validateSiteToSiteCapabilities(value, true, remote.capabilities);
        const reciprocal = remote.rows.filter((row) => row.siteVpnType === 0 && row.vpnType === value.vpnType && row.remoteSite === params.siteId);
        if (reciprocal.length > (id ? 1 : 0)) throw new Error('Remote site already has a conflicting automatic VPN');
        return;
    }
    if (value.networkType === 0) {
        const networks = await readResourceRows((page) => read(`${SITE}/lan-networks`, { ...params, page, pageSize: 100 }));
        if ((value.networkList as string[]).some((id) => !networks.some((row) => row.id === id))) throw new Error('VPN local network does not exist');
    }
    if (value.vpnType === 4) {
        if (
            rows.some(
                (row) =>
                    row.id !== id &&
                    row.siteVpnType === 1 &&
                    row.vpnType === 4 &&
                    (row.servicePort === value.servicePort || row.tunnelIp === value.tunnelIp)
            )
        )
            throw new Error('WireGuard tunnel address or service port is already in use');
        return;
    }
    const internet = await read(`${SITE}/internet/basic-info`, params);
    if (!object(internet) || !Array.isArray(internet.portList) || internet.portList.length > 1000) throw new Error('WAN inventory is unavailable');
    const ports = internet.portList;
    if (ports.some((port) => !object(port) || typeof port.portId !== 'string') || new Set(ports.map((p) => p.portId)).size !== ports.length)
        throw new Error('WAN identity is missing or ambiguous');
    const selected = [...(value.wans as string[])];
    if (object(value.failoverSetting) && value.failoverSetting.failover) selected.push(String(value.failoverSetting.backupWan));
    if (selected.some((id) => !ports.some((port) => port.portId === id && port.portMode === 0)))
        throw new Error('Every selected WAN must be configured as a WAN');
}
