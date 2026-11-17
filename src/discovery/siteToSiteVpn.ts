import { isIP } from 'node:net';
import { z } from 'zod';
import type { ApiOperation } from './catalog.js';
import { type ResourceRead, type ResourceRow, readResourceRows } from './resourceInventory.js';
import {
    advanced,
    base,
    ids,
    ipv4,
    localNetworks,
    port,
    readVpnInventory,
    SITE_TO_SITE_PATH,
    subnets,
    validateVpnNetworkReferences,
    validateVpnNetworkSelection,
} from './vpnShared.js';
import { vpnEndpoint, wireguardKey } from './wireguard.js';

export type SiteToSiteKind = 'vpn-manual' | 'vpn-auto' | 'vpn-delete';
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
    validateVpnNetworkSelection(value);
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
        const remote = await readVpnInventory(read, { ...params, siteId: value.remoteSite }, 'site-to-site');
        validateSiteToSiteCapabilities(value, true, remote.capabilities);
        const reciprocal = remote.rows.filter((row) => row.siteVpnType === 0 && row.vpnType === value.vpnType && row.remoteSite === params.siteId);
        if (reciprocal.length > (id ? 1 : 0)) throw new Error('Remote site already has a conflicting automatic VPN');
        return;
    }
    await validateVpnNetworkReferences(value, read, params);
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
}
