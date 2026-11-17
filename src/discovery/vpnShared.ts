import { isIP } from 'node:net';
import { z } from 'zod';
import { type ResourceRead, readResourceRows } from './resourceInventory.js';
import { vpnCidr } from './wireguard.js';

const SITE = '/openapi/v1/{omadacId}/sites/{siteId}';
export const SITE_TO_SITE_PATH = '/openapi/v2/{omadacId}/sites/{siteId}/vpn/site-to-site-vpns';
export const VPN_DELETE_PATH = '/openapi/v2/{omadacId}/sites/{siteId}/vpn/{vpnId}';
export const VPN_PATHS = {
    'site-to-site': SITE_TO_SITE_PATH,
    server: '/openapi/v2/{omadacId}/sites/{siteId}/vpn/client-to-site-vpn-servers',
    client: '/openapi/v2/{omadacId}/sites/{siteId}/vpn/client-to-site-vpn-clients',
} as const;
export type VpnFamily = keyof typeof VPN_PATHS;
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export const base = { name: z.string().regex(/^[a-zA-Z0-9_]{1,63}$/), status: z.boolean() };
export const ipv4 = z.string().refine((value) => isIP(value) === 4, 'Expected an IPv4 address');
export const port = z.number().int().min(1).max(65535);
export const ids = z
    .array(z.string().min(1))
    .min(1)
    .max(1000)
    .refine((values) => new Set(values).size === values.length, 'IDs must be unique');
export const subnets = z
    .array(vpnCidr)
    .min(1)
    .max(1000)
    .refine((values) => new Set(values.map((v) => v.toLowerCase())).size === values.length, 'Subnets must be unique');

export const localNetworks = {
    networkType: z.union([z.literal(0), z.literal(1)]).optional(),
    networkList: ids.optional(),
    customNetwork: z
        .array(z.object({ ip: ipv4, mask: z.number().int().min(0).max(32) }).strict())
        .min(1)
        .max(1000)
        .optional(),
    existCustomNetwork: z.boolean().optional(),
};
export const advanced = z
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
export function comparableVpn(value: Record<string, unknown>): Record<string, unknown> {
    const result = { ...value };
    for (const key of ['remoteSubnet', 'networkList', 'wans', 'vpnUserList', 'allowedAddress', 'allowedServerAddress'])
        if (Array.isArray(result[key])) result[key] = [...result[key]].sort();
    if (Array.isArray(result.customNetwork))
        result.customNetwork = [...result.customNetwork].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (Array.isArray(result.peers))
        result.peers = result.peers
            .map((peer) => (object(peer) ? comparableVpn(peer) : peer))
            .sort((a, b) => String(a?.serverPublicKey).localeCompare(String(b?.serverPublicKey)));
    if (Array.isArray(result.clients))
        result.clients = result.clients
            .map((client) => (object(client) ? comparableVpn(client) : client))
            .sort((a, b) => String(a?.interfaceIp).localeCompare(String(b?.interfaceIp)));
    return result;
}

export async function readVpnInventory(read: ResourceRead, params: Record<string, unknown>, family: VpnFamily) {
    const path = VPN_PATHS[family];
    let capabilities: Record<string, unknown> = {};
    const rows = await readResourceRows(async (page) => {
        const result = await read(path, { ...params, page, pageSize: 100 });
        if (page === 1 && object(result)) capabilities = result;
        return result;
    });
    if (rows.length > 100) throw new Error('VPN detail inventory exceeds 100 VPNs');
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const detail = await read(`${path}/{vpnId}`, { ...params, vpnId: row.id });
        if (
            !object(detail) ||
            ['id', 'name', 'status', 'vpnType', ...(family === 'site-to-site' ? ['siteVpnType'] : [])].some(
                (key) => detail[key] === undefined || detail[key] !== row[key]
            )
        )
            throw new Error('VPN summary and detail identities disagree');
        rows[index] = { ...detail, id: row.id, vpnFamily: family };
    }
    return { rows, capabilities };
}

export function validateVpnNetworkSelection(value: Record<string, unknown>): void {
    if (value.networkType === 0 && (!(Array.isArray(value.networkList) && value.networkList.length) || value.customNetwork !== undefined))
        throw new Error('Network-list mode requires networkList only');
    if (value.networkType === 1 && (!(Array.isArray(value.customNetwork) && value.customNetwork.length) || value.networkList !== undefined))
        throw new Error('Custom-network mode requires customNetwork only');
    if (
        value.networkType === undefined &&
        (value.networkList !== undefined || value.customNetwork !== undefined || value.existCustomNetwork !== undefined)
    )
        throw new Error('Local network selection requires networkType');
    if (value.existCustomNetwork !== undefined && value.existCustomNetwork !== (value.networkType === 1))
        throw new Error('Conflicting custom-network selector');
    if (Array.isArray(value.customNetwork) && new Set(value.customNetwork.map((n) => `${n.ip}/${n.mask}`)).size !== value.customNetwork.length)
        throw new Error('Custom networks must be unique');
}

export async function validateVpnNetworkReferences(
    value: Record<string, unknown>,
    read: ResourceRead,
    params: Record<string, unknown>
): Promise<void> {
    if (value.networkType === 0) {
        const networks = await readResourceRows((page) => read(`${SITE}/lan-networks`, { ...params, page, pageSize: 100 }));
        if ((value.networkList as string[]).some((id) => !networks.some((row) => row.id === id))) throw new Error('VPN local network does not exist');
    }
    if (!Array.isArray(value.wans)) return;
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
