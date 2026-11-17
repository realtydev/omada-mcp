import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import { GenericOperations } from '../../src/omadaClient/generic.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const document = JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8'));
const catalog = new OperationCatalog(document, 'bundled');
const privateKey = Buffer.alloc(32, 1).toString('base64');
const clientKey = Buffer.alloc(32, 2).toString('base64');
const publicKey = Buffer.alloc(32, 3).toString('base64');
const child = { name: 'Laptop', interfaceIp: '192.0.2.10', privateKey: clientKey, preSharedKey: '', allowedAddressStatus: false };
const serverBase = { name: 'RemoteAccess', status: true, wans: ['wan'], servicePort: 51820, ipPoolType: 0, ipPool: { ip: '192.0.2.0', mask: 24 } };
const wgServer = { ...serverBase, vpnType: 4, privateKey, mtu: 1420, keepAlive: 25, clients: [] };
const openServer = {
    ...serverBase,
    vpnType: 3,
    servicePort: 1194,
    serviceType: 0,
    tunnelMode: 0,
    networkType: 0,
    networkList: ['lan'],
    accountAuth: false,
};
const wgClient = {
    name: 'Outbound',
    status: true,
    vpnType: 4,
    setup: 1,
    wans: ['wan'],
    remoteIp: '203.0.113.2',
    servicePort: 51820,
    clientPort: 51821,
    tunnelIp: '192.0.2.10',
    privateKey,
    serverPublicKey: publicKey,
    preSharedKey: '',
    mtu: 1420,
    keepAlive: 25,
    allowedServerAddress: ['203.0.113.0/24', '2001:db8::/64'],
};
const fileWg = {
    name: 'Imported',
    status: true,
    vpnType: 4,
    setup: 0,
    wans: ['wan'],
    vpnConfiguration: { id: 'certificate', fileName: 'client.conf' },
};
const openClient = {
    name: 'Imported',
    status: true,
    vpnType: 3,
    wans: ['wan'],
    openVpnMode: 0,
    vpnConfiguration: { id: 'certificate', fileName: 'client.ovpn' },
};
type Row = Record<string, unknown> & { id: string };
type Family = 'site-to-site' | 'server' | 'client';
function setup(
    options: {
        server?: Row[];
        client?: Row[];
        siteToSite?: Row[];
        caps?: Record<string, unknown>;
        networks?: unknown;
        ports?: unknown;
        users?: unknown;
        profiles?: unknown;
        drift?: boolean;
        incomplete?: boolean;
        ambiguousDetail?: boolean;
        missingFamily?: boolean;
        mask?: boolean;
        missingReadback?: string;
        extraClient?: boolean;
        lost?: boolean;
        reject?: boolean;
        apply?: boolean;
    } = {}
) {
    const rows: Record<Family, Row[]> = {
        server: structuredClone(options.server ?? []),
        client: structuredClone(options.client ?? []),
        'site-to-site': structuredClone(options.siteToSite ?? []),
    };
    const caps = {
        supportServerClientWireGuard: true,
        supportIpRange: true,
        supportCustomNetwork: true,
        supportCustomServer: true,
        supportDnsStatus: true,
        supportAccountAuth: true,
        supportLdap: true,
        supportTunnelMode: true,
        supportWgDomain: true,
        wgPeerLimitSize: 100,
        subnetsLimitSize: 100,
        ...options.caps,
    };
    const reads = new Map<string, number>();
    let sent = false;
    const mask = (value: unknown): unknown =>
        Array.isArray(value)
            ? value.map(mask)
            : value && typeof value === 'object'
              ? Object.fromEntries(
                    Object.entries(value).map(([key, child]) => [
                        key,
                        /privateKey|preSharedKey|clientPassword/i.test(key) && child ? '********' : mask(child),
                    ])
                )
              : value;
    const request = {
        request: vi.fn((config, _retry?: boolean) => {
            if (config.url.endsWith('/lan-networks')) return { errorCode: 0, result: options.networks ?? [{ id: 'lan' }] };
            if (config.url.endsWith('/internet/basic-info'))
                return { errorCode: 0, result: { portList: options.ports ?? [{ portId: 'wan', portMode: 0 }] } };
            if (config.url.endsWith('/profiles/ldap')) return { errorCode: 0, result: options.profiles ?? [{ id: 'ldap' }] };
            if (config.url.endsWith('/vpn/users')) return { errorCode: 0, result: options.users ?? [] };
            const family: Family = config.url.includes('client-to-site-vpn-servers')
                ? 'server'
                : config.url.includes('client-to-site-vpn-clients')
                  ? 'client'
                  : 'site-to-site';
            if (config.method === 'GET') {
                if (options.missingFamily && family === 'client') return { errorCode: -1, msg: 'Unavailable inventory' };
                if (/\/(site-to-site-vpns|client-to-site-vpn-servers|client-to-site-vpn-clients)$/.test(config.url)) {
                    const count = (reads.get(family) ?? 0) + 1;
                    reads.set(family, count);
                    if (options.drift && count === 2) rows[family] = [...rows[family], { ...wgServer, id: 'concurrent', name: 'Concurrent' }];
                    const data = rows[family]
                        .slice((config.params.page - 1) * 2, config.params.page * 2)
                        .map(({ id, name, status, vpnType, siteVpnType }) => ({
                            id,
                            name,
                            status,
                            vpnType,
                            ...(family === 'site-to-site' ? { siteVpnType } : {}),
                        }));
                    return {
                        errorCode: 0,
                        result: { ...caps, data, currentPage: config.params.page, totalRows: rows[family].length + (options.incomplete ? 1 : 0) },
                    };
                }
                const row = rows[family].find((row) => config.url.endsWith(`/${row.id}`));
                if (!row) return { errorCode: -1, msg: 'Not found' };
                let detail = structuredClone(row);
                if (Array.isArray(detail.clients)) detail.clients = detail.clients.map((c) => ({ ...c, id: 'child-id', publicKey }));
                if (options.mask) detail = mask(detail) as Row;
                if (options.ambiguousDetail) detail.id = 'wrong';
                if (sent && options.missingReadback) delete detail[options.missingReadback];
                if (sent && options.extraClient)
                    detail.clients = [...(detail.clients as unknown[]), { ...child, name: 'Extra', interfaceIp: '192.0.2.11' }];
                return { errorCode: 0, result: detail };
            }
            sent = true;
            if (options.reject) return { errorCode: -1, msg: `Rejected ${config.data?.privateKey ?? config.data?.clientPassword}` };
            if (options.apply !== false) {
                if (config.method === 'POST') rows[family].push({ ...config.data, id: 'new' });
                if (config.method === 'PATCH')
                    rows[family] = rows[family].map((row) => (config.url.endsWith(`/${row.id}`) ? { id: row.id, ...config.data } : row));
                if (config.method === 'DELETE')
                    for (const key of Object.keys(rows) as Family[]) rows[key] = rows[key].filter((row) => !config.url.endsWith(`/${row.id}`));
            }
            if (options.lost) throw new Error('Lost acknowledgement');
            return { errorCode: 0 };
        }),
        ensureSuccess: (response: { errorCode: number; result?: unknown; msg?: string }) => {
            if (response.errorCode !== 0) throw Object.assign(new Error(response.msg), { errorCode: response.errorCode });
            return response.result;
        },
    };
    const run = (
        operationId = 'createVpnServer',
        body: unknown = operationId === 'createVpnServer' ? wgServer : undefined,
        params: Record<string, unknown> = {},
        dryRun?: boolean,
        policy = new ToolAccessPolicy('full', 'security:rw,network:r')
    ) =>
        executeDiscoveredOperation(
            catalog,
            request as never,
            { operationId, ...(body === undefined ? {} : { body }), params, ...(dryRun === undefined ? {} : { dryRun }) },
            { omadacId: 'controller', siteId: 'site', readOnly: false, accessPolicy: policy }
        );
    return { run, request, writes: () => request.request.mock.calls.filter(([config]) => config.method !== 'GET') };
}

describe('guarded v2 client-to-site VPNs', () => {
    it('describes protocol-specific requirements without modifying the bundled schema', () => {
        for (const id of ['createVpnServer', 'createVpnClient'])
            expect(catalog.describe(id).requestBody?.schema).toMatchObject({
                required: ['name', 'status', 'vpnType', 'wans'],
                allOf: expect.any(Array),
            });
        expect(document.components.schemas.VpnServerConfigOpenApiVO.required).toContain('nameLockSetting');
    });
    it('previews every supported configuration locally and redacts nested secrets', async () => {
        const f = setup();
        for (const [operation, body] of [
            ['createVpnServer', { ...wgServer, clients: [child] }],
            ['createVpnServer', openServer],
            ['createVpnClient', wgClient],
            ['createVpnClient', fileWg],
            ['createVpnClient', { ...openClient, openVpnMode: 1, clientUsername: 'user', clientPassword: 'test-password' }],
        ] as const) {
            const result = await f.run(operation, body);
            expect(result).toMatchObject({ dryRun: true, written: false });
            for (const secret of [privateKey, clientKey, 'test-password']) expect(JSON.stringify(result)).not.toContain(secret);
        }
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it.each([
        ['createVpnServer', wgServer],
        ['createVpnServer', openServer],
        ['createVpnClient', wgClient],
        ['createVpnClient', fileWg],
        ['createVpnClient', openClient],
    ])('creates, updates and deletes %s without deprecated VPN endpoints', async (operation, body) => {
        const f = setup();
        const created = await f.run(operation, body, {}, false);
        expect(created).toMatchObject({ written: true, verified: body === openServer, verification: { resourceId: 'new' } });
        const modify = operation === 'createVpnServer' ? 'modifyVpnServer' : 'modifyVpnClient';
        expect(await f.run(modify, { ...body, name: 'Renamed' }, { vpnId: 'new' }, false)).toMatchObject({ written: true });
        expect(await f.run('deleteVpnV2', undefined, { vpnId: 'new' }, false)).toMatchObject({ written: true, verified: true });
        expect(f.writes()).toHaveLength(3);
        expect(f.writes().every(([config, retry]) => retry === false && config.url.startsWith('/openapi/v2/'))).toBe(true);
        expect(f.writes()[1][0].method).toBe('PATCH');
        expect(f.writes()[2][0].url).toBe('/openapi/v2/controller/sites/site/vpn/new');
        expect(f.request.request.mock.calls.some(([config]) => config.url.endsWith('/site-to-site-vpns'))).toBe(true);
    });
    it('replaces explicit WireGuard clients and requires removal before deleting their server', async () => {
        const f = setup({ mask: true });
        expect(await f.run('createVpnServer', { ...wgServer, clients: [{ ...child, preSharedKey: publicKey }] }, {}, false)).toMatchObject({
            written: true,
            verified: false,
            notVerifiedFields: ['privateKey', 'clients.0.privateKey', 'clients.0.preSharedKey'],
        });
        await expect(f.run('deleteVpnV2', undefined, { vpnId: 'new' }, false)).rejects.toThrow('Remove WireGuard clients');
        expect(await f.run('modifyVpnServer', wgServer, { vpnId: 'new' }, false)).toMatchObject({ written: true });
        expect(f.writes()[1][0].data.clients).toEqual([]);
        expect(await f.run('deleteVpnV2', undefined, { vpnId: 'new' }, false)).toMatchObject({ verified: true });
    });
    it('requires explicit keys/passwords rather than copying masked values', async () => {
        const { preSharedKey: _psk, ...noPsk } = wgClient;
        const { privateKey: _private, ...noPrivate } = child;
        for (const [operation, body] of [
            ['modifyVpnClient', noPsk],
            ['modifyVpnServer', { ...wgServer, clients: [noPrivate] }],
            ['modifyVpnClient', { ...openClient, openVpnMode: 1, clientUsername: 'user' }],
        ] as const) {
            const f = setup({ server: [{ ...wgServer, id: 'old' }], client: [{ ...wgClient, id: 'old' }], mask: true });
            await expect(f.run(operation, body, { vpnId: 'old' }, false)).rejects.toThrow();
            expect(f.request.request).not.toHaveBeenCalled();
        }
    });
    it('supports empty local user selection and refuses deleting associated users', async () => {
        const body = { ...openServer, accountAuth: true, authMode: 0, vpnUserList: [] };
        const f = setup();
        expect(await f.run('createVpnServer', body, {}, false)).toMatchObject({ verified: true });
        expect(await f.run('deleteVpnV2', undefined, { vpnId: 'new' }, false)).toMatchObject({ verified: true });
        const attached = setup({ server: [{ ...body, vpnUserList: ['user'], id: 'old' }], users: [{ id: 'user', protocol: 1, servers: [] }] });
        await expect(attached.run('deleteVpnV2', undefined, { vpnId: 'old' }, false)).rejects.toThrow('Detach VPN users');
        expect(await attached.run('modifyVpnServer', body, { vpnId: 'old' }, false)).toMatchObject({ written: true, verified: true });
        expect(await attached.run('deleteVpnV2', undefined, { vpnId: 'old' }, false)).toMatchObject({ verified: true });
        for (const users of [[{ id: 'user', servers: ['old'] }], [{ id: 'user' }]]) {
            const blocked = setup({ server: [{ ...body, id: 'old' }], users });
            await expect(blocked.run('deleteVpnV2', undefined, { vpnId: 'old' }, false)).rejects.toThrow('associations');
            expect(blocked.writes()).toHaveLength(0);
        }
    });
    it('qualifies local users and LDAP profiles and changes authentication explicitly', async () => {
        const f = setup({ users: [{ id: 'user', protocol: 1, servers: [] }] });
        expect(await f.run('createVpnServer', { ...openServer, accountAuth: true, authMode: 0, vpnUserList: ['user'] }, {}, false)).toMatchObject({
            verified: true,
        });
        expect(
            await f.run('modifyVpnServer', { ...openServer, accountAuth: true, authMode: 1, ldapProfile: 'ldap' }, { vpnId: 'new' }, false)
        ).toMatchObject({ verified: true });
        expect(f.writes()[1][0].data).not.toHaveProperty('vpnUserList');
        expect(await f.run('modifyVpnServer', openServer, { vpnId: 'new' }, false)).toMatchObject({ verified: true });
        expect(f.writes()[2][0].data).not.toHaveProperty('ldapProfile');
        await expect(
            setup({ profiles: [] }).run('createVpnServer', { ...openServer, accountAuth: true, authMode: 1, ldapProfile: 'missing' }, {}, false)
        ).rejects.toThrow('LDAP profile');
        await expect(
            setup({ users: [{ id: 'user', protocol: 0 }] }).run(
                'createVpnServer',
                { ...openServer, accountAuth: true, authMode: 0, vpnUserList: ['user'] },
                {},
                false
            )
        ).rejects.toThrow('OpenVPN user');
    });
    it.each([
        ['createVpnServer', { ...wgServer, vpnType: 0 }],
        ['createVpnClient', { ...wgClient, vpnType: 1 }],
        ['createVpnServer', { ...wgServer, clients: [child, child] }],
        ['createVpnServer', { ...wgServer, clients: [{ ...child, interfaceIp: '203.0.113.2' }] }],
        ['createVpnServer', { ...wgServer, clients: [{ ...child, interfaceIp: '192.0.2.0' }] }],
        ['createVpnServer', { ...wgServer, clients: [{ ...child, allowedAddressStatus: true }] }],
        ['createVpnServer', { ...wgServer, ipPoolType: 1, ipPool: undefined, ipPoolStart: '192.0.2.20', ipPoolEnd: '192.0.2.10' }],
        ['createVpnServer', { ...wgServer, customServer: true }],
        ['createVpnServer', { ...openServer, accountAuth: true }],
        ['createVpnClient', { ...fileWg, vpnConfiguration: { id: 'certificate', fileName: '../client.conf' } }],
        ['createVpnClient', { ...fileWg, vpnConfiguration: { id: 'certificate', fileName: 'client.ovpn' } }],
        ['createVpnClient', { ...wgClient, privateKey: '********' }],
        ['createVpnClient', { ...wgClient, mtu: 1500 }],
        ['createVpnClient', { ...wgClient, allowedServerAddress: ['203.0.113.0/33'] }],
        ['createVpnClient', { ...openClient, clientPassword: 'unexpected' }],
    ])('rejects invalid or unsupported %s inputs before IO', async (operation, body) => {
        const f = setup();
        await expect(f.run(operation, body)).rejects.toThrow();
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it('qualifies required capabilities and WAN/LAN evidence before writing', async () => {
        for (const options of [{ caps: { supportServerClientWireGuard: false } }, { ports: [] }, { ports: [{ portId: 'wan', portMode: 1 }] }]) {
            const f = setup(options);
            await expect(f.run('createVpnServer', wgServer, {}, false)).rejects.toThrow();
            expect(f.writes()).toHaveLength(0);
        }
        await expect(setup({ networks: [] }).run('createVpnServer', openServer, {}, false)).rejects.toThrow('network does not exist');
        await expect(
            setup({ caps: { supportLdap: false } }).run(
                'createVpnServer',
                { ...openServer, accountAuth: true, authMode: 1, ldapProfile: 'ldap' },
                {},
                false
            )
        ).rejects.toThrow('supportLdap');
        await expect(
            setup({ caps: { supportWgDomain: false } }).run('createVpnClient', { ...wgClient, remoteIp: 'vpn.example' }, {}, false)
        ).rejects.toThrow('supportWgDomain');
        const f = setup({ server: [{ ...wgServer, name: 'Existing', id: 'old' }] });
        await expect(f.run('createVpnServer', wgServer, {}, false)).rejects.toThrow('listen port');
        expect(f.writes()).toHaveLength(0);
    });
    it('preserves writable configuration, ignores child metadata and compares address sets exactly', async () => {
        const body = { ...wgServer, clients: [{ ...child, allowedAddressStatus: true, allowedAddress: ['192.0.2.10/32', '203.0.113.0/24'] }] };
        const f = setup({ server: [{ ...body, customServer: true, customServerAddress: 'vpn.example', id: 'old' }] });
        expect(await f.run('modifyVpnServer', { ...body, name: 'Renamed' }, { vpnId: 'old' }, false)).toMatchObject({
            written: true,
            verification: { status: 'unknown' },
        });
        expect(f.writes()[0][0].data).toMatchObject({ customServerAddress: 'vpn.example' });
        expect(f.writes()[0][0].data.clients[0]).not.toHaveProperty('id');
        expect(f.writes()[0][0].data.clients[0]).not.toHaveProperty('publicKey');
        expect(await setup({ extraClient: true }).run('createVpnServer', { ...wgServer, clients: [child] }, {}, false)).toMatchObject({
            verified: false,
            verification: { status: 'mismatch' },
        });
        const noOp = setup({ client: [{ ...wgClient, id: 'old', allowedServerAddress: [...wgClient.allowedServerAddress].reverse() }] });
        expect(await noOp.run('modifyVpnClient', wgClient, { vpnId: 'old' }, false)).toMatchObject({ written: false, verified: false });
        expect(noOp.writes()).toHaveLength(0);
    });
    it('refuses protocol/import-mode changes and ambiguous, missing or incomplete delete inventories', async () => {
        const f = setup({ client: [{ ...wgClient, id: 'old' }] });
        await expect(f.run('modifyVpnClient', fileWg, { vpnId: 'old' }, false)).rejects.toThrow('explicit replacement');
        await expect(f.run('modifyVpnClient', openClient, { vpnId: 'old' }, false)).rejects.toThrow('explicit replacement');
        for (const options of [
            {},
            { server: [{ ...wgServer, id: 'old' }], client: [{ ...wgClient, id: 'old' }] },
            { server: [{ ...wgServer, id: 'old' }], missingFamily: true },
            { server: [{ ...wgServer, id: 'old' }], incomplete: true },
        ]) {
            const blocked = setup(options);
            await expect(blocked.run('deleteVpnV2', undefined, { vpnId: 'old' }, false)).rejects.toThrow();
            expect(blocked.writes()).toHaveLength(0);
        }
    });
    it('retains site-to-site deletion and unchanged client/server siblings', async () => {
        const s2s = {
            name: 'SiteLink',
            status: true,
            siteVpnType: 1,
            vpnType: 4,
            mtu: 1420,
            servicePort: 51820,
            tunnelIp: '192.0.2.1',
            privateKey,
            peers: [],
            id: 'site-link',
        };
        const f = setup({ siteToSite: [s2s], server: [{ ...openServer, id: 'server' }], client: [{ ...wgClient, id: 'client' }] });
        expect(await f.run('deleteVpnV2', undefined, { vpnId: 'site-link' }, false)).toMatchObject({ verified: true });
        expect(f.writes()).toHaveLength(1);
        expect(f.writes()[0][0].url).toBe('/openapi/v2/controller/sites/site/vpn/site-link');
    });
    it('reports imported contents and missing readback unverified without replaying uncertain writes', async () => {
        expect(await setup().run('createVpnClient', fileWg, {}, false)).toMatchObject({
            notVerifiedFields: ['vpnConfiguration.contents'],
            verified: false,
        });
        expect(await setup({ missingReadback: 'clients' }).run('createVpnServer', wgServer, {}, false)).toMatchObject({
            verified: false,
            verification: { status: 'unknown' },
        });
        const f = setup({ lost: true });
        expect(await f.run('createVpnServer', openServer, {}, false)).toMatchObject({ written: 'unknown', verified: true });
        expect(f.writes()).toHaveLength(1);
        await expect(
            setup({ reject: true }).run(
                'createVpnClient',
                { ...openClient, openVpnMode: 1, clientUsername: 'user', clientPassword: 'test-password' },
                {},
                false
            )
        ).rejects.toMatchObject({ message: 'Rejected [redacted]', errorCode: -1 });
    });
    it('keeps disable-only recovery while still detecting drift and enforcing scopes and raw guards', async () => {
        const f = setup({ server: [{ ...openServer, id: 'old' }], ports: [], networks: [], caps: { supportTunnelMode: false } });
        expect(
            await f.run('modifyVpnServer', { ...openServer, status: false }, { vpnId: 'old' }, false, new ToolAccessPolicy('full', 'security:rw'))
        ).toMatchObject({ written: true, verified: true });
        const drift = setup({ server: [{ ...openServer, id: 'old' }], drift: true });
        await expect(drift.run('modifyVpnServer', { ...openServer, status: false }, { vpnId: 'old' }, false)).rejects.toThrow(
            'changed during preflight'
        );
        expect(drift.writes()).toHaveLength(0);
        for (const policy of [
            new ToolAccessPolicy('read-only'),
            new ToolAccessPolicy('full', 'security:r'),
            new ToolAccessPolicy('full', 'security:w'),
            new ToolAccessPolicy('full', 'security:rw'),
        ])
            await expect(setup().run('createVpnServer', wgServer, {}, false, policy)).rejects.toThrow(/not permitted|Read-only/);
        const raw = new GenericOperations(f.request as never, (path) => `/openapi/v1/controller${path}`);
        for (const version of ['v1', 'v2'])
            for (const path of ['/sites/site/vpn/client-to-site-vpn-servers', '/sites/site/vpn/client-to-site-vpn-clients/id'])
                await expect(raw.genericApiCall('POST', path, version, wgServer)).rejects.toThrow('executeApiOperation');
    });
    it('ignores inactive controller defaults during disable-only recovery', async () => {
        const f = setup({
            server: [{ ...openServer, authMode: 0, vpnUserList: [], ldapProfile: '', ipPoolStart: '192.0.2.5', ipPoolEnd: '192.0.2.20', id: 'old' }],
            ports: [],
            networks: [],
        });
        expect(
            await f.run('modifyVpnServer', { ...openServer, status: false }, { vpnId: 'old' }, false, new ToolAccessPolicy('full', 'security:rw'))
        ).toMatchObject({ written: true, verified: true });
        expect(f.writes()[0][0].data).not.toHaveProperty('authMode');
        expect(f.writes()[0][0].data).not.toHaveProperty('ipPoolStart');
    });
    it('corrects only the exact vendor credential patterns and retains validation for live changes', async () => {
        const body = { ...openClient, openVpnMode: 1, clientUsername: 'user+[]', clientPassword: 'test+[]-password' };
        expect(await setup().run('createVpnClient', body)).toMatchObject({ dryRun: true });
        await expect(setup().run('createVpnClient', { ...body, clientUsername: 'user name' })).rejects.toThrow();
        const changed = structuredClone(document);
        changed.components.schemas.VpnClientConfigOpenApiVO.properties.clientUsername.pattern = '^required-name$';
        const f = setup();
        await expect(
            executeDiscoveredOperation(
                new OperationCatalog(changed, 'live'),
                f.request as never,
                { operationId: 'createVpnClient', body },
                { omadacId: 'controller', siteId: 'site', readOnly: false }
            )
        ).rejects.toThrow('Invalid operation input');
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it('distinguishes UDP and TCP server listeners while refusing missing transport evidence', async () => {
        const tcp = { ...openServer, servicePort: 51820, serviceType: 1, name: 'TCP', id: 'old' };
        expect(await setup({ server: [tcp] }).run('createVpnServer', wgServer, {}, false)).toMatchObject({ written: true });
        const { serviceType: _type, ...unknown } = tcp;
        await expect(setup({ server: [unknown] }).run('createVpnServer', wgServer, {}, false)).rejects.toThrow('listen port');
    });
});
