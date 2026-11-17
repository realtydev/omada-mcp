import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import { GenericOperations } from '../../src/omadaClient/generic.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const document = JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8'));
const catalog = new OperationCatalog(document, 'bundled');
const privateKey = Buffer.alloc(32, 1).toString('base64');
const publicKey = Buffer.alloc(32, 2).toString('base64');
const preSharedKey = Buffer.alloc(32, 3).toString('base64');
const peer = {
    name: 'Peer',
    status: true,
    serverPublicKey: publicKey,
    preSharedKey: '',
    remoteSubnet: ['192.0.2.2/32', '2001:db8::/64'],
    keepAlive: 25,
};
const wg = { name: 'WireGuard', status: true, vpnType: 4, mtu: 1420, servicePort: 51820, tunnelIp: '192.0.2.1', privateKey, peers: [peer] };
const ipsec = {
    name: 'IPSec',
    status: true,
    vpnType: 2,
    wans: ['wan'],
    remoteIp: '203.0.113.2',
    remoteSubnet: ['203.0.113.0/24'],
    preSharedKey: 'test-ipsec-key',
    networkType: 0,
    networkList: ['lan'],
    advancedSetting: {
        keyExchangeVersion: 1,
        phase1Proposal1: 2,
        phase1Proposal2: 4,
        phase1Proposal3: 3,
        phase2Proposal1: 1,
        phase2Proposal2: 2,
        phase2Proposal3: 4,
        pfs: 14,
        dpd: true,
        dpdInterval: 30,
    },
};
const automatic = { name: 'Automatic', status: true, vpnType: 4, remoteSite: 'remote' };
type Row = Record<string, unknown> & { id: string };
function setup(
    options: {
        rows?: Row[];
        remote?: Row[];
        caps?: Record<string, unknown>;
        remoteCaps?: Record<string, unknown>;
        sites?: unknown;
        networks?: unknown;
        ports?: unknown;
        incomplete?: boolean;
        drift?: boolean;
        conflictingDetail?: boolean;
        mask?: boolean;
        lost?: boolean;
        reject?: boolean;
        apply?: boolean;
        missingReadback?: boolean;
        extraPeer?: boolean;
        wrongMode?: boolean;
    } = {}
) {
    const data: Record<string, Row[]> = { site: structuredClone(options.rows ?? []), remote: structuredClone(options.remote ?? []) };
    const caps = {
        supportIPsec: true,
        supportAutoWireGuard: true,
        supportWgDomain: true,
        supportManualWgLocalNetwork: true,
        supportCustomNetwork: true,
        supportIPsecFailover: true,
        wgPeerLimitSize: 100,
        subnetsLimitSize: 100,
        ...options.caps,
    };
    let listReads = 0,
        sent = false;
    const request = {
        request: vi.fn((config, _retry?: boolean) => {
            if (config.url.endsWith('/sites'))
                return {
                    errorCode: 0,
                    result: {
                        data: options.sites ?? [{ siteId: 'site' }, { siteId: 'remote' }],
                        totalRows: Array.isArray(options.sites) ? options.sites.length : 2,
                        currentPage: 1,
                    },
                };
            if (config.url.endsWith('/lan-networks')) return { errorCode: 0, result: options.networks ?? [{ id: 'lan' }] };
            if (config.url.endsWith('/internet/basic-info'))
                return {
                    errorCode: 0,
                    result: {
                        portList: options.ports ?? [
                            { portId: 'wan', portMode: 0 },
                            { portId: 'backup', portMode: 0 },
                        ],
                    },
                };
            const site = config.url.includes('/sites/remote/') ? 'remote' : 'site';
            let rows = data[site];
            if (config.method === 'GET') {
                if (config.url.endsWith('/site-to-site-vpns')) {
                    if (site === 'site' && config.params.page === 1) listReads++;
                    if (options.drift && listReads === 2 && site === 'site')
                        rows = data[site] = [...rows, { ...automatic, id: 'concurrent', name: 'Concurrent', siteVpnType: 0 }];
                    const summaries = rows
                        .slice((config.params.page - 1) * 2, config.params.page * 2)
                        .map(({ id, name, status, vpnType, siteVpnType }) => ({ id, name, status, vpnType, siteVpnType }));
                    return {
                        errorCode: 0,
                        result: {
                            ...caps,
                            ...(site === 'remote' ? options.remoteCaps : {}),
                            data: summaries,
                            currentPage: config.params.page,
                            totalRows: rows.length + (options.incomplete ? 1 : 0),
                        },
                    };
                }
                const row = rows.find((row) => config.url.endsWith(`/${row.id}`));
                if (!row) return { errorCode: -1, msg: 'Not found' };
                const detail = structuredClone(row);
                if (options.conflictingDetail) detail.id = 'wrong';
                if (options.mask) {
                    if (detail.privateKey) detail.privateKey = '********';
                    if (detail.preSharedKey) detail.preSharedKey = '********';
                    if (Array.isArray(detail.peers))
                        detail.peers = detail.peers.map((p) => ({ ...p, preSharedKey: p.preSharedKey ? '********' : '' }));
                }
                if (sent && options.missingReadback) delete detail.peers;
                if (sent && options.extraPeer)
                    detail.peers = [...(detail.peers as unknown[]), { ...peer, serverPublicKey: preSharedKey, name: 'Extra' }];
                return { errorCode: 0, result: detail };
            }
            sent = true;
            if (options.reject) return { errorCode: -33474, msg: `Rejected ${config.data?.privateKey ?? config.data?.preSharedKey}` };
            if (options.apply !== false) {
                const mode = config.url.includes('/auto') ? 0 : 1;
                if (config.method === 'POST') rows = [...rows, { ...config.data, siteVpnType: options.wrongMode ? 1 - mode : mode, id: 'new' }];
                if (config.method === 'PATCH') rows = rows.map((row) => (config.url.endsWith(`/${row.id}`) ? { ...row, ...config.data } : row));
                if (config.method === 'DELETE') rows = rows.filter((row) => !config.url.endsWith(`/${row.id}`));
                data[site] = rows;
            }
            if (options.lost) throw new Error('Lost acknowledgement');
            return { errorCode: 0 };
        }),
        ensureSuccess: (response: { errorCode: number; msg?: string; result?: unknown }) => {
            if (response.errorCode !== 0) throw Object.assign(new Error(response.msg), { errorCode: response.errorCode });
            return response.result;
        },
    };
    const run = (
        operationId = 'createS2SManualVpn',
        body: unknown = operationId === 'createS2SManualVpn' ? wg : undefined,
        params: Record<string, unknown> = {},
        dryRun?: boolean,
        policy = new ToolAccessPolicy('full', 'security:rw,network:r,system:r')
    ) =>
        executeDiscoveredOperation(
            catalog,
            request as never,
            { operationId, ...(body === undefined ? {} : { body }), params, ...(dryRun === undefined ? {} : { dryRun }) },
            { omadacId: 'controller', siteId: 'site', readOnly: false, accessPolicy: policy }
        );
    return { run, request, writes: () => request.request.mock.calls.filter(([config]) => config.method !== 'GET') };
}

describe('v2 site-to-site VPNs', () => {
    it('describes conditional manual requirements without changing the source spec', () => {
        const schema = catalog.describe('createS2SManualVpn').requestBody?.schema;
        expect(schema?.required).toEqual(['name', 'status', 'vpnType']);
        expect(schema?.allOf).toEqual(
            expect.arrayContaining([expect.objectContaining({ then: { required: ['mtu', 'privateKey', 'servicePort', 'tunnelIp', 'peers'] } })])
        );
        expect(document.components.schemas.VpnSiteToSiteManualConfigOpenApiVO.required).toContain('advancedSetting');
    });
    it('previews all modes without HTTP and redacts nested keys', async () => {
        const f = setup();
        for (const [operationId, body] of [
            ['createS2SManualVpn', { ...wg, peers: [{ ...peer, preSharedKey }] }],
            ['createS2SManualVpn', ipsec],
            ['createS2SAutoVpn', automatic],
        ] as const) {
            const result = await f.run(operationId, body);
            expect(result).toMatchObject({ dryRun: true, written: false });
            for (const key of [privateKey, preSharedKey, ipsec.preSharedKey]) expect(JSON.stringify(result)).not.toContain(key);
        }
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it.each([
        { ...wg, mtu: 1500 },
        { ...wg, peers: undefined },
        { ...wg, vpnType: 3 },
        { ...wg, tunnelIp: 'prefix192.0.2.1suffix' },
        { ...wg, peers: [{ ...peer, preSharedKey: '********' }] },
        { ...wg, peers: [{ ...peer, preSharedKey: undefined }] },
        { ...wg, peers: [peer, peer] },
        { ...wg, peers: [{ ...peer, remoteSubnet: ['192.0.2.0/33'] }] },
        { ...wg, peers: [{ ...peer, remoteIp: '203.0.113.2' }] },
        { ...wg, peers: [{ ...peer, remoteIp: 'http://vpn.example', servicePort: 51820 }] },
        { ...wg, wans: ['wan'] },
        { ...ipsec, privateKey },
        { ...ipsec, wans: [] },
        { ...ipsec, preSharedKey: '********' },
        { ...ipsec, networkList: [] },
        { ...ipsec, customNetwork: [{ ip: '192.0.2.0', mask: 24 }] },
        { ...ipsec, advancedSetting: { ...ipsec.advancedSetting, pfs: 13 } },
        { ...ipsec, advancedSetting: { dpd: true } },
        { ...ipsec, advancedSetting: { localIdType: 1 } },
        { ...ipsec, advancedSetting: { saLifetime: 59 } },
        { ...ipsec, failoverSetting: { failover: true, backupWan: 'wan', failback: false } },
        { ...ipsec, failoverSetting: { failover: true } },
    ])('rejects invalid or mixed manual configuration before IO', async (body) => {
        const f = setup();
        await expect(f.run('createS2SManualVpn', body)).rejects.toThrow();
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it('creates and updates WireGuard with nested secret-aware verification and deletes only an empty VPN', async () => {
        const f = setup({ mask: true });
        const body = { ...wg, peers: [{ ...peer, preSharedKey }] };
        const result = await f.run('createS2SManualVpn', body, {}, false);
        expect(result).toMatchObject({
            written: true,
            verified: false,
            verification: { status: 'unknown', resourceId: 'new' },
            notVerifiedFields: ['privateKey', 'peers.0.preSharedKey'],
        });
        expect(f.writes()[0][0]).toMatchObject({ method: 'POST', url: '/openapi/v2/controller/sites/site/vpn/site-to-site-vpns', data: body });
        await expect(f.run('deleteVpnV2', undefined, { vpnId: 'new' }, false)).rejects.toThrow('Remove WireGuard peers');
        expect(await f.run('modifyS2SManualVpn', { ...wg, peers: [] }, { vpnId: 'new' }, false)).toMatchObject({ written: true, verified: false });
        expect(f.writes()[1][0]).toMatchObject({
            method: 'PATCH',
            url: '/openapi/v2/controller/sites/site/vpn/site-to-site-vpns/new',
            data: { peers: [] },
        });
        expect(await f.run('deleteVpnV2', undefined, { vpnId: 'new' }, false)).toMatchObject({ written: true, verified: true });
        expect(f.writes()[2][0].url).toBe('/openapi/v2/controller/sites/site/vpn/new');
        expect(f.writes().every(([, retry]) => retry === false)).toBe(true);
        expect(f.request.request.mock.calls.every(([config]) => !config.url.includes('/openapi/v1/'))).toBe(true);
    });
    it('creates IPSec using WAN/network references, preserves advanced options and reports PSK unverified', async () => {
        const f = setup({ mask: true });
        expect(await f.run('createS2SManualVpn', ipsec, {}, false)).toMatchObject({
            written: true,
            verified: false,
            notVerifiedFields: ['preSharedKey'],
        });
        expect(
            await f.run(
                'modifyS2SManualVpn',
                { ...ipsec, status: false, advancedSetting: { ...ipsec.advancedSetting, dpdInterval: 60 } },
                { vpnId: 'new' },
                false
            )
        ).toMatchObject({ written: true });
        expect(f.writes()[1][0].data).not.toHaveProperty('privateKey');
        expect(f.writes()[1][0].data.advancedSetting.phase1Proposal2).toBe(4);
        expect(await f.run('deleteVpnV2', undefined, { vpnId: 'new' }, false)).toMatchObject({ verified: true });
    });
    it.each([2, 4])('creates, disables and deletes automatic type %i with honest remote provisioning status', async (vpnType) => {
        const f = setup();
        const body = { ...automatic, vpnType };
        expect(await f.run('createS2SAutoVpn', body, {}, false)).toMatchObject({
            written: true,
            verified: false,
            notVerifiedFields: ['remoteSiteConfiguration'],
        });
        expect(f.writes()[0][0].url).toBe('/openapi/v2/controller/sites/site/vpn/site-to-site-vpns/auto');
        expect(await f.run('modifyS2SAutoVpn', { ...body, status: false }, { vpnId: 'new' }, false)).toMatchObject({
            written: true,
            verified: false,
        });
        expect(await f.run('deleteVpnV2', undefined, { vpnId: 'new' }, false)).toMatchObject({
            written: true,
            verified: false,
            notVerifiedFields: ['remoteSiteConfiguration'],
        });
        expect(f.writes()).toHaveLength(3);
    });
    it('refuses automatic self-reference, unavailable sites/capabilities, duplicates and retargeting', async () => {
        const f = setup();
        await expect(f.run('createS2SAutoVpn', { ...automatic, remoteSite: 'site' })).rejects.toThrow('different remote site');
        expect(f.request.request).not.toHaveBeenCalled();
        for (const options of [
            { sites: [{ siteId: 'site' }] },
            { remoteCaps: { supportAutoWireGuard: false } },
            { rows: [{ ...automatic, id: 'old', siteVpnType: 0, name: 'Other' }] },
            { remote: [{ ...automatic, remoteSite: 'site', id: 'other', siteVpnType: 0 }] },
        ]) {
            const bad = setup(options);
            await expect(bad.run('createS2SAutoVpn', automatic, {}, false)).rejects.toThrow();
            expect(bad.writes()).toHaveLength(0);
        }
        const existing = setup({ rows: [{ ...automatic, siteVpnType: 0, id: 'old' }] });
        await expect(existing.run('modifyS2SAutoVpn', { ...automatic, remoteSite: 'other' }, { vpnId: 'old' }, false)).rejects.toThrow('remote site');
        await expect(existing.run('modifyS2SAutoVpn', { ...automatic, vpnType: 2 }, { vpnId: 'old' }, false)).rejects.toThrow('protocol');
        expect(existing.writes()).toHaveLength(0);
    });
    it('rejects incompatible targets and unqualified shared deletions', async () => {
        for (const rows of [[], [{ ...automatic, siteVpnType: 0, id: 'old' }], [{ ...wg, siteVpnType: 1, id: 'old', vpnType: 3 }]]) {
            const f = setup({ rows });
            await expect(f.run('modifyS2SManualVpn', wg, { vpnId: 'old' }, false)).rejects.toThrow();
            expect(f.writes()).toHaveLength(0);
        }
        const f = setup();
        await expect(f.run('deleteVpnV2', undefined, { vpnId: 'unknown' }, false)).rejects.toThrow('not a qualified');
        expect(f.writes()).toHaveLength(0);
    });
    it('requires explicit nested peer keys and never copies masked stored keys', async () => {
        const { preSharedKey: _key, ...withoutKey } = peer;
        const f = setup({ rows: [{ ...wg, id: 'old', siteVpnType: 1 }], mask: true });
        await expect(f.run('modifyS2SManualVpn', { ...wg, peers: [withoutKey] }, { vpnId: 'old' }, false)).rejects.toThrow();
        expect(f.request.request).not.toHaveBeenCalled();
        expect(await f.run('modifyS2SManualVpn', { ...wg, name: 'Renamed' }, { vpnId: 'old' }, false)).toMatchObject({ written: true });
        expect(f.writes()[0][0].data).toMatchObject({ privateKey, peers: [{ preSharedKey: '' }] });
    });
    it('does not send a shared VPN delete for an unqualified client-to-site or unsupported target', async () => {
        for (const options of [{}, { rows: [{ ...wg, id: 'client-server', vpnType: 3, siteVpnType: 1 }] }]) {
            const f = setup(options);
            await expect(f.run('deleteVpnV2', undefined, { vpnId: 'client-server' }, false)).rejects.toThrow('not a qualified site-to-site');
            expect(f.writes()).toHaveLength(0);
        }
    });
    it('preserves omitted advanced settings and removes inactive local-network selections', async () => {
        const f = setup({ rows: [{ ...ipsec, id: 'old', siteVpnType: 1, existCustomNetwork: false }] });
        const { networkList: _networks, ...body } = ipsec;
        expect(
            await f.run(
                'modifyS2SManualVpn',
                { ...body, networkType: 1, customNetwork: [{ ip: '192.0.2.0', mask: 24 }], advancedSetting: { saLifetime: 3600 } },
                { vpnId: 'old' },
                false
            )
        ).toMatchObject({ written: true });
        expect(f.writes()[0][0].data).not.toHaveProperty('networkList');
        expect(f.writes()[0][0].data).toMatchObject({ existCustomNetwork: true, advancedSetting: { ...ipsec.advancedSetting, saLifetime: 3600 } });
    });
    it.each([{ incomplete: true }, { drift: true }, { conflictingDetail: true, rows: [{ ...wg, id: 'old', siteVpnType: 1 }] }])(
        'refuses incomplete, conflicting and drifting inventories',
        async (options) => {
            const f = setup(options);
            await expect(f.run('createS2SManualVpn', wg, {}, false)).rejects.toThrow();
            expect(f.writes()).toHaveLength(0);
        }
    );
    it('qualifies WANs, subnets, crypto choices and advertised optional features', async () => {
        for (const options of [
            { networks: [] },
            { ports: [{ portId: 'wan', portMode: 1 }] },
            {
                ports: [
                    { portId: 'wan', portMode: 0 },
                    { portId: 'wan', portMode: 0 },
                ],
            },
            { caps: { supportIPsec: false } },
            { caps: { subnetsLimitSize: 0 } },
            { caps: { phase1Proposal1Cap: [0, 1] } },
        ]) {
            const f = setup(options);
            await expect(f.run('createS2SManualVpn', ipsec, {}, false)).rejects.toThrow();
            expect(f.writes()).toHaveLength(0);
        }
        const withDomain = { ...wg, peers: [{ ...peer, remoteIp: 'vpn.example', servicePort: 51820 }] };
        await expect(setup({ caps: { supportWgDomain: false } }).run('createS2SManualVpn', withDomain, {}, false)).rejects.toThrow('supportWgDomain');
        await expect(setup({ caps: { wgPeerLimitSize: 0 } }).run('createS2SManualVpn', wg, {}, false)).rejects.toThrow('wgPeerLimitSize');
        const custom = { ...wg, networkType: 1, customNetwork: [{ ip: '192.0.2.0', mask: 24 }] };
        await expect(setup({ caps: { supportManualWgLocalNetwork: false } }).run('createS2SManualVpn', custom, {}, false)).rejects.toThrow(
            'supportManualWgLocalNetwork'
        );
        expect(await setup().run('createS2SManualVpn', custom, {}, false)).toMatchObject({ written: true });
        expect(
            await setup().run(
                'createS2SManualVpn',
                { ...ipsec, failoverSetting: { failover: true, backupWan: 'backup', failback: true, failbackTime: 60 } },
                {},
                false
            )
        ).toMatchObject({ written: true });
    });
    it('reads every page and ignores peer ordering for no-ops while never verifying secrets', async () => {
        const rows = [1, 2, 3].map((n) => ({ ...automatic, name: `Old${n}`, id: `old${n}`, siteVpnType: 0, remoteSite: `remote${n}` }));
        const f = setup({ rows });
        expect(await f.run('createS2SManualVpn', wg, {}, false)).toMatchObject({ written: true });
        expect(f.request.request.mock.calls.some(([config]) => config.params?.page === 2)).toBe(true);
        const reordered = setup({
            rows: [{ ...wg, id: 'old', siteVpnType: 1, peers: [{ ...peer, remoteSubnet: [...peer.remoteSubnet].reverse() }] }],
        });
        expect(await reordered.run('modifyS2SManualVpn', wg, { vpnId: 'old' }, false)).toMatchObject({ written: false, verified: false });
        expect(reordered.writes()).toHaveLength(0);
    });
    it('keeps disable-only recovery available without WAN/network/remote dependencies', async () => {
        const f = setup({ rows: [{ ...ipsec, id: 'old', siteVpnType: 1 }], networks: [], ports: [], caps: { supportIPsec: false } });
        expect(
            await f.run('modifyS2SManualVpn', { ...ipsec, status: false }, { vpnId: 'old' }, false, new ToolAccessPolicy('full', 'security:rw'))
        ).toMatchObject({ written: true });
        const changed = setup({ rows: [{ ...ipsec, id: 'old', siteVpnType: 1 }], networks: [] });
        await expect(changed.run('modifyS2SManualVpn', { ...ipsec, status: false, name: 'Changed' }, { vpnId: 'old' }, false)).rejects.toThrow(
            'network does not exist'
        );
        expect(changed.writes()).toHaveLength(0);
    });
    it('detects missing details and extra peers; lost replies never trigger replay', async () => {
        expect(await setup({ missingReadback: true }).run('createS2SManualVpn', wg, {}, false)).toMatchObject({
            verified: false,
            verification: { status: 'unknown' },
        });
        expect(await setup({ extraPeer: true }).run('createS2SManualVpn', wg, {}, false)).toMatchObject({
            verified: false,
            verification: { status: 'mismatch' },
        });
        expect(await setup({ wrongMode: true }).run('createS2SManualVpn', wg, {}, false)).toMatchObject({
            verified: false,
            verification: { status: 'mismatch' },
        });
        const f = setup({ lost: true });
        expect(await f.run('createS2SManualVpn', wg, {}, false)).toMatchObject({ written: 'unknown', verified: false });
        expect(f.writes()).toHaveLength(1);
        await expect(setup({ reject: true }).run('createS2SManualVpn', ipsec, {}, false)).rejects.toMatchObject({
            message: 'Rejected [redacted]',
            errorCode: -33474,
        });
    });
    it('enforces scopes and rejects raw/version bypasses', async () => {
        const f = setup();
        for (const policy of [
            new ToolAccessPolicy('read-only'),
            new ToolAccessPolicy('full', 'security:r'),
            new ToolAccessPolicy('full', 'security:w'),
            new ToolAccessPolicy('full', 'security:rw'),
        ])
            await expect(f.run('createS2SManualVpn', ipsec, {}, false, policy)).rejects.toThrow(/not permitted|Read-only/);
        await expect(f.run('createS2SAutoVpn', automatic, {}, false, new ToolAccessPolicy('full', 'security:rw'))).rejects.toThrow('not permitted');
        const raw = new GenericOperations(f.request as never, (path) => `/openapi/v1/controller${path}`);
        for (const version of ['v1', 'v2'])
            for (const path of ['/sites/site/vpn/site-to-site-vpns', '/sites/site/vpn/site-to-site-vpns/auto/id', '/sites/site/vpn/id'])
                await expect(raw.genericApiCall('DELETE', path, version)).rejects.toThrow('executeApiOperation');
        await expect(f.run('createSiteToSiteVpn', { name: 'Legacy', status: true, siteVpnType: 0, remoteSite: 'remote' }, {}, false)).rejects.toThrow(
            'site-to-site VPNs use v2'
        );
        expect(f.writes()).toHaveLength(0);
    });
});
