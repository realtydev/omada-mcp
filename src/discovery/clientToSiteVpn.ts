import { isIP } from 'node:net';
import { z } from 'zod';
import type { ApiOperation } from './catalog.js';
import { type ResourceRead, type ResourceRow, readResourceRows } from './resourceInventory.js';
import { base, ids, ipv4, localNetworks, port, subnets, VPN_PATHS, validateVpnNetworkReferences, validateVpnNetworkSelection } from './vpnShared.js';
import { vpnEndpoint, wireguardKey } from './wireguard.js';

export type ClientToSiteKind = 'vpn-server' | 'vpn-client';
const uniqueIds = z
    .array(z.string().min(1))
    .max(1000)
    .refine((values) => new Set(values).size === values.length, 'IDs must be unique');
const dns = { dns1: ipv4.or(z.literal('')).optional(), dns2: ipv4.or(z.literal('')).optional() };
const networks = { networkType: localNetworks.networkType, networkList: localNetworks.networkList, customNetwork: localNetworks.customNetwork };
const pool = {
    ipPoolType: z.union([z.literal(0), z.literal(1)]),
    ipPool: z
        .object({ ip: ipv4, mask: z.number().int().min(1).max(32) })
        .strict()
        .optional(),
    ipPoolStart: ipv4.optional(),
    ipPoolEnd: ipv4.optional(),
};
const serverBase = {
    ...base,
    wans: ids,
    servicePort: port,
    ...pool,
    ...networks,
    customServer: z.boolean().optional(),
    customServerAddress: vpnEndpoint.optional(),
    ...dns,
};
const wgClient = z
    .object({
        name: z
            .string()
            .min(1)
            .max(64)
            .refine((value) => value === value.trim(), 'Client name cannot start or end with whitespace'),
        interfaceIp: ipv4,
        privateKey: wireguardKey,
        preSharedKey: z.union([z.literal(''), wireguardKey]),
        allowedAddressStatus: z.boolean(),
        allowedAddress: subnets.optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.allowedAddressStatus !== Boolean(value.allowedAddress?.length))
            ctx.addIssue({ code: 'custom', path: ['allowedAddress'], message: 'Supply allowedAddress only when allowedAddressStatus is true' });
    });
const wgServer = z
    .object({
        ...serverBase,
        vpnType: z.literal(4),
        mtu: z.number().int().min(576).max(1440),
        keepAlive: z.number().int().min(0).max(65535),
        privateKey: wireguardKey,
        dnsStatus: z.boolean().optional(),
        clients: z
            .array(wgClient)
            .max(100)
            .refine(
                (values) =>
                    (['name', 'interfaceIp', 'privateKey'] as const).every(
                        (key) => new Set(values.map((v) => (key === 'name' ? v.name.toLowerCase() : v[key]))).size === values.length
                    ),
                'WireGuard client names, addresses and private keys must be unique'
            ),
    })
    .strict();
const openServer = z
    .object({
        ...serverBase,
        vpnType: z.literal(3),
        serviceType: z.union([z.literal(0), z.literal(1)]),
        tunnelMode: z.union([z.literal(0), z.literal(1)]),
        accountAuth: z.boolean(),
        authMode: z.union([z.literal(0), z.literal(1)]).optional(),
        ldapProfile: z.string().min(1).optional(),
        vpnUserList: uniqueIds.optional(),
    })
    .strict();
const certificate = z
    .object({
        id: z.string().min(1).max(256),
        fileName: z
            .string()
            .min(1)
            .max(255)
            .refine(
                (name) =>
                    !/[\\/]/.test(name) &&
                    !Array.from(name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
                    name !== '.' &&
                    name !== '..',
                'Expected a certificate filename'
            ),
    })
    .strict();
const clientBase = { ...base, wans: ids, ...networks };
const importedWg = z.object({ ...clientBase, vpnType: z.literal(4), setup: z.literal(0), vpnConfiguration: certificate }).strict();
const manualWg = z
    .object({
        ...clientBase,
        vpnType: z.literal(4),
        setup: z.literal(1),
        tunnelIp: ipv4,
        servicePort: port,
        clientPort: port,
        remoteIp: vpnEndpoint.refine(Boolean, 'Remote endpoint is required'),
        mtu: z.number().int().min(576).max(1440),
        keepAlive: z.number().int().min(0).max(65535),
        privateKey: wireguardKey,
        serverPublicKey: wireguardKey,
        preSharedKey: z.union([z.literal(''), wireguardKey]),
        allowedServerAddress: subnets,
        ...dns,
    })
    .strict();
const openClient = z
    .object({
        ...clientBase,
        vpnType: z.literal(3),
        openVpnMode: z.union([z.literal(0), z.literal(1)]),
        vpnConfiguration: certificate,
        clientUsername: z.string().min(1).max(64).optional(),
        clientPassword: z
            .string()
            .min(1)
            .max(128)
            .refine((v) => !/^\*+$/.test(v) && v !== '[redacted]', 'Supply an explicit unmasked password')
            .optional(),
    })
    .strict();

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function schemaFor(kind: ClientToSiteKind, body: Record<string, unknown>) {
    if (kind === 'vpn-server') return body.vpnType === 4 ? wgServer : openServer;
    return body.vpnType === 3 ? openClient : body.setup === 0 ? importedWg : manualWg;
}
const ipNumber = (ip: string) => ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);

/** Narrowly correct the bundled union of unrelated protocol requirements; retain every property constraint. */
export function clientToSiteRequestSchema(
    operation: Pick<ApiOperation, 'method' | 'path'>,
    schema: Record<string, unknown>
): Record<string, unknown> {
    const server = [VPN_PATHS.server, `${VPN_PATHS.server}/{vpnId}`].includes(operation.path);
    const client = [VPN_PATHS.client, `${VPN_PATHS.client}/{vpnId}`].includes(operation.path);
    if (!['POST', 'PATCH'].includes(operation.method) || (!server && !client) || !Array.isArray(schema.required) || !object(schema.properties))
        return schema;
    const original = server
        ? [
              'advancedSetting',
              'exitAtIdle',
              'ipLockSetting',
              'keepAlive',
              'mtu',
              'name',
              'nameLockSetting',
              'preSharedKey',
              'privateKey',
              'remoteIp',
              'servicePort',
              'serviceType',
              'status',
              'vpnType',
              'vpnUserList',
              'wans',
          ]
        : ['name', 'remoteIp', 'serverPublicKey', 'servicePort', 'setup', 'status', 'vpnConfiguration', 'vpnType', 'wans'];
    if (
        schema.required.length !== original.length ||
        !original.every((key) => (schema.required as unknown[]).includes(key) && object(schema.properties) && schema.properties[key])
    )
        return schema;
    const properties = { ...schema.properties };
    // These exact vendor Java-style nested classes enumerate printable ASCII but cannot compile as Unicode JSON Schema regexes.
    if (client) {
        if (
            object(properties.clientUsername) &&
            properties.clientUsername.pattern === '^[-A-Za-z0-9`~!@#$&*()=+\\[\\][\\\\\\\\\\\\\\\\]{};:\'\\\\\\\\\\\\\\"|/?.,<>%^_]{1,64}$'
        )
            properties.clientUsername = { ...properties.clientUsername, pattern: '^[\\x21-\\x7e]{1,64}$' };
        if (
            object(properties.clientPassword) &&
            properties.clientPassword.pattern === '^[A-Za-z0-9`~!@#$&*()_=+\\[\\][\\\\\\\\]{};:\'\\\\\\"|/?.,<>%^\\\\\\\\/-]{1,128}$'
        )
            properties.clientPassword = { ...properties.clientPassword, pattern: '^[\\x21-\\x7e]{1,128}$' };
    }
    const contracts = server ? [wgServer, openServer] : [manualWg, importedWg, openClient];
    return {
        ...schema,
        properties,
        required: ['name', 'status', 'vpnType', 'wans'],
        allOf: [
            ...(Array.isArray(schema.allOf) ? schema.allOf : []),
            ...contracts.map((contract) => ({
                if: {
                    properties: {
                        vpnType: { const: contract === openClient || contract === openServer ? 3 : 4 },
                        ...(contract === manualWg || contract === importedWg ? { setup: { const: contract === importedWg ? 0 : 1 } } : {}),
                    },
                    required: ['vpnType', ...(contract === manualWg || contract === importedWg ? ['setup'] : [])],
                },
                then: {
                    required: Object.entries(contract.shape)
                        .filter(([, field]) => !field.isOptional())
                        .map(([key]) => key),
                },
            })),
        ],
    };
}

export function validateClientToSiteInput(kind: ClientToSiteKind, body: unknown): void {
    if (!object(body) || (body.vpnType !== 3 && body.vpnType !== 4))
        throw new Error('Guarded client-to-site configuration supports WireGuard and OpenVPN only');
    const value = schemaFor(kind, body).parse(body);
    validateVpnNetworkSelection(value);
    if (kind === 'vpn-server') {
        const server = value as z.infer<typeof wgServer> | z.infer<typeof openServer>;
        if (server.ipPoolType === 0 && (!server.ipPool || server.ipPoolStart !== undefined || server.ipPoolEnd !== undefined))
            throw new Error('Subnet pool requires ipPool only');
        if (
            server.ipPoolType === 1 &&
            (!server.ipPoolStart || !server.ipPoolEnd || server.ipPool !== undefined || ipNumber(server.ipPoolStart) > ipNumber(server.ipPoolEnd))
        )
            throw new Error('Range pool requires ordered ipPoolStart and ipPoolEnd only');
        if (server.customServer && (!server.customServerAddress || isIP(server.customServerAddress) === 6))
            throw new Error('Custom server requires an IPv4 address or hostname');
        if (!server.customServer && server.customServerAddress) throw new Error('Custom server address requires customServer:true');
        if (server.vpnType === 4) {
            for (const client of server.clients) {
                const address = ipNumber(client.interfaceIp);
                const size = server.ipPool ? 2 ** (32 - server.ipPool.mask) : 0;
                const start = server.ipPool ? Math.floor(ipNumber(server.ipPool.ip) / size) * size : ipNumber(server.ipPoolStart as string);
                const end = server.ipPool ? start + size - 1 : ipNumber(server.ipPoolEnd as string);
                if (address < start || address > end || (server.ipPool && server.ipPool.mask < 31 && (address === start || address === end)))
                    throw new Error('WireGuard client address must be a usable address in the configured pool');
            }
        } else {
            if (server.tunnelMode === 0 && server.networkType === undefined)
                throw new Error('Split-tunnel OpenVPN requires an explicit local network selection');
            if (server.accountAuth && server.authMode === undefined) throw new Error('Account authentication requires an explicit authMode');
            if (!server.accountAuth && (server.authMode !== undefined || server.ldapProfile !== undefined || server.vpnUserList !== undefined))
                throw new Error('Authentication fields require accountAuth:true');
            if (server.authMode === 0 && (!server.vpnUserList || server.ldapProfile !== undefined))
                throw new Error('Local authentication requires explicit vpnUserList only');
            if (server.authMode === 1 && (!server.ldapProfile || server.vpnUserList !== undefined))
                throw new Error('LDAP authentication requires ldapProfile only');
        }
    } else {
        if (
            object(body.vpnConfiguration) &&
            !String(body.vpnConfiguration.fileName)
                .toLowerCase()
                .endsWith(body.vpnType === 4 ? '.conf' : '.ovpn')
        )
            throw new Error('Imported configuration requires a .conf WireGuard or .ovpn OpenVPN filename');
        if (body.vpnType === 3) {
            if (body.openVpnMode === 1 && (!body.clientUsername || !body.clientPassword))
                throw new Error('Account mode requires explicit username and password');
            if (body.openVpnMode === 0 && (body.clientUsername !== undefined || body.clientPassword !== undefined))
                throw new Error('Certificate-only mode cannot include account credentials');
        }
    }
}

export function clientToSiteConfig(kind: ClientToSiteKind, row: Record<string, unknown>): Record<string, unknown> {
    const result = Object.fromEntries(
        Object.keys(schemaFor(kind, row).shape)
            .filter((key) => row[key] !== undefined)
            .map((key) => [key, row[key]])
    );
    if (Array.isArray(result.clients))
        result.clients = result.clients.map((client) =>
            object(client)
                ? Object.fromEntries(
                      Object.keys(wgClient.shape)
                          .filter((key) => client[key] !== undefined && !(key === 'allowedAddress' && client.allowedAddressStatus === false))
                          .map((key) => [key, client[key]])
                  )
                : client
        );
    if (row.ipPoolType === 0 && object(result.ipPool)) result.ipPool = { ip: result.ipPool.ip, mask: result.ipPool.mask };
    normalizeClientToSiteUpdate(kind, result);
    return result;
}

/** An explicit selector change removes preserved values from its now-inactive branch. */
export function normalizeClientToSiteUpdate(kind: ClientToSiteKind, value: Record<string, unknown>): void {
    if (value.networkType === 0) delete value.customNetwork;
    if (value.networkType === 1) delete value.networkList;
    if (kind === 'vpn-server') {
        if (value.ipPoolType === 0) {
            delete value.ipPoolStart;
            delete value.ipPoolEnd;
        }
        if (value.ipPoolType === 1) delete value.ipPool;
        if (value.customServer === false) delete value.customServerAddress;
        if (value.accountAuth === false) {
            delete value.authMode;
            delete value.vpnUserList;
            delete value.ldapProfile;
        }
        if (value.authMode === 0) delete value.ldapProfile;
        if (value.authMode === 1) delete value.vpnUserList;
    } else if (value.vpnType === 3 && value.openVpnMode === 0) {
        delete value.clientUsername;
        delete value.clientPassword;
    }
}

export function validateClientToSiteCapabilities(value: Record<string, unknown>, kind: ClientToSiteKind, caps: Record<string, unknown>): void {
    const requireFlag = (flag: string) => {
        if (caps[flag] !== true) throw new Error(`Controller has not advertised ${flag}`);
    };
    if (value.vpnType === 4) requireFlag('supportServerClientWireGuard');
    if (value.networkType === 1) requireFlag('supportCustomNetwork');
    if (kind === 'vpn-server') {
        if (value.ipPoolType === 1) requireFlag('supportIpRange');
        if (value.customServer === true) requireFlag('supportCustomServer');
        if (value.dnsStatus !== undefined) requireFlag('supportDnsStatus');
        if (value.accountAuth === true) requireFlag('supportAccountAuth');
        if (value.authMode === 1) requireFlag('supportLdap');
        if (value.tunnelMode !== undefined) requireFlag('supportTunnelMode');
    } else if (typeof value.remoteIp === 'string' && value.remoteIp && !isIP(value.remoteIp)) requireFlag('supportWgDomain');
    for (const [field, lists] of [
        ['wgPeerLimitSize', [value.clients]],
        [
            'subnetsLimitSize',
            [
                value.networkList,
                value.customNetwork,
                value.allowedServerAddress,
                ...(Array.isArray(value.clients) ? value.clients.map((c) => (object(c) ? c.allowedAddress : undefined)) : []),
            ],
        ],
    ] as const) {
        if (
            caps[field] !== undefined &&
            (!Number.isSafeInteger(caps[field]) ||
                Number(caps[field]) < 0 ||
                lists.some((list) => Array.isArray(list) && list.length > Number(caps[field])))
        )
            throw new Error(`Configuration exceeds or cannot qualify ${field}`);
    }
}

export async function validateClientToSiteReferences(
    value: Record<string, unknown>,
    kind: ClientToSiteKind,
    rows: ResourceRow[],
    id: string | undefined,
    read: ResourceRead,
    params: Record<string, unknown>
): Promise<void> {
    await validateVpnNetworkReferences(value, read, params);
    if (
        kind === 'vpn-server' &&
        value.servicePort !== undefined &&
        rows.some(
            (row) =>
                row.id !== id &&
                row.servicePort === value.servicePort &&
                ((row.vpnType !== 4 && row.serviceType !== 0 && row.serviceType !== 1) ||
                    (row.vpnType === 4 ? 0 : row.serviceType) === (value.vpnType === 4 ? 0 : value.serviceType)) &&
                (!Array.isArray(row.wans) || (value.wans as string[]).some((wan) => (row.wans as unknown[]).includes(wan)))
        )
    )
        throw new Error('VPN server listen port is already in use on a selected WAN');
    if (value.authMode === 1) {
        const profiles = await readResourceRows(() => read('/openapi/v1/{omadacId}/sites/{siteId}/profiles/ldap', params), ['profileId']);
        if (!profiles.some((row) => row.id === value.ldapProfile)) throw new Error('LDAP profile does not exist');
    }
    if (Array.isArray(value.vpnUserList) && value.vpnUserList.length) {
        const users = await readResourceRows((page) => read('/openapi/v2/{omadacId}/sites/{siteId}/vpn/users', { ...params, page, pageSize: 100 }));
        if (value.vpnUserList.some((id) => !users.some((user) => user.id === id && user.protocol === 1)))
            throw new Error('Selected user is not an existing OpenVPN user');
    }
}

export async function validateClientVpnDeletion(row: ResourceRow, read: ResourceRead, params: Record<string, unknown>): Promise<void> {
    if (row.vpnFamily !== 'server') return;
    if (row.vpnType === 4) {
        if (!Array.isArray(row.clients) || row.clients.length) throw new Error('Remove WireGuard clients explicitly before deleting their server');
        return;
    }
    if (row.vpnUserList !== undefined && (!Array.isArray(row.vpnUserList) || row.vpnUserList.length))
        throw new Error('Detach VPN users explicitly before deleting their server');
    const users = await readResourceRows((page) => read('/openapi/v2/{omadacId}/sites/{siteId}/vpn/users', { ...params, page, pageSize: 100 }));
    if (
        users.some(
            (user) => !Array.isArray(user.servers) || user.servers.some((server) => typeof server !== 'string') || user.servers.includes(row.id)
        )
    )
        throw new Error('VPN user associations are present or unknown; detach users before deleting their server');
}
