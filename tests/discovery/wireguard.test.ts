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
const presharedKey = Buffer.alloc(32, 3).toString('base64');
const iface = { name: 'Office tunnel', status: true, mtu: 1420, listenPort: 51820, privateKey, localIp: '192.0.2.1' };
const peer = {
    name: 'Office peer',
    status: true,
    interfaceId: 'interface',
    publicKey,
    allowAddress: ['192.0.2.2/32', '2001:db8::/64'],
    presharedKey: '',
    keepAlive: 25,
};
type Row = Record<string, unknown> & { id: string };
function setup(
    options: {
        interfaces?: Row[];
        peers?: Row[];
        supportDomain?: boolean;
        incomplete?: boolean;
        drift?: boolean;
        lost?: boolean;
        reject?: boolean;
        apply?: boolean;
        missingReadback?: boolean;
        extraReadback?: boolean;
        maskKeys?: boolean;
    } = {}
) {
    let interfaces = structuredClone(options.interfaces ?? [{ ...iface, id: 'interface' }]);
    let peers = structuredClone(options.peers ?? []);
    let sent = false;
    const reads = new Map<string, number>();
    const request = {
        request: vi.fn((config, _retry?: boolean) => {
            const isPeer = config.url.includes('/wireguard-peers');
            let rows = isPeer ? peers : interfaces;
            if (config.method === 'GET') {
                const count = (reads.get(config.url) ?? 0) + 1;
                reads.set(config.url, count);
                if (options.drift && count === 2) rows = [...rows, { ...peer, id: 'concurrent', name: 'Concurrent' }];
                let data = rows.slice((config.params.page - 1) * 2, config.params.page * 2);
                if (sent && options.missingReadback) data = data.map(({ status: _status, ...row }) => row);
                if (sent && options.extraReadback)
                    data = data.map((row) => ({ ...row, allowAddress: [...(row.allowAddress as string[]), '203.0.113.0/24'] }));
                if (options.maskKeys) data = data.map((row) => ({ ...row, ...(isPeer ? { presharedKey: '********' } : { privateKey: '********' }) }));
                return {
                    errorCode: 0,
                    result: {
                        data,
                        currentPage: config.params.page,
                        totalRows: rows.length + (options.incomplete ? 1 : 0),
                        ...(isPeer ? { supportDomain: options.supportDomain ?? false } : {}),
                    },
                };
            }
            sent = true;
            if (options.reject) return { errorCode: -43208, msg: `Rejected ${config.data?.privateKey ?? config.data?.presharedKey}` };
            if (options.apply !== false) {
                if (config.method === 'POST') rows = [...rows, { ...config.data, id: 'new' }];
                if (config.method === 'PUT') rows = rows.map((row) => (config.url.endsWith(`/${row.id}`) ? { ...config.data, id: row.id } : row));
                if (config.method === 'DELETE') rows = rows.filter((row) => !config.url.endsWith(`/${row.id}`));
                if (isPeer) peers = rows;
                else interfaces = rows;
            }
            if (options.lost) throw new Error('lost acknowledgement');
            return { errorCode: 0, ...(config.method === 'POST' ? { result: { id: 'new' } } : {}) };
        }),
        ensureSuccess: (response: { errorCode: number; msg?: string; result?: unknown }) => {
            if (response.errorCode !== 0) throw Object.assign(new Error(response.msg), { errorCode: response.errorCode });
            return response.result;
        },
    };
    const run = (
        operationId = 'createPeer',
        body: unknown = operationId === 'createPeer' ? peer : undefined,
        params: Record<string, unknown> = {},
        dryRun = false,
        policy = new ToolAccessPolicy('full', 'security:rw')
    ) =>
        executeDiscoveredOperation(
            catalog,
            request as never,
            { operationId, ...(body === undefined ? {} : { body }), params, dryRun },
            { omadacId: 'controller', siteId: 'site', readOnly: false, accessPolicy: policy }
        );
    return { run, request, writes: () => request.request.mock.calls.filter(([config]) => config.method !== 'GET') };
}

describe('guarded WireGuard configuration', () => {
    it('previews locally and redacts both key types', async () => {
        const f = setup();
        for (const [operationId, body, secret] of [
            ['createWireguard', iface, privateKey],
            ['createPeer', { ...peer, presharedKey }, presharedKey],
        ] as const) {
            const result = await f.run(operationId, body, {}, true);
            expect(result).toMatchObject({ dryRun: true, written: false, verified: false });
            expect(JSON.stringify(result)).not.toContain(secret);
            expect(JSON.stringify(result)).toContain('[redacted]');
        }
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it.each([
        ['createWireguard', { ...iface, mtu: 1441 }],
        ['createWireguard', { ...iface, listenPort: 0 }],
        ['createWireguard', { ...iface, localIp: 'prefix192.0.2.1suffix' }],
        ['createWireguard', { ...iface, privateKey: '********' }],
        ['createWireguard', { ...iface, privateKey: `${'A'.repeat(42)}B=` }],
        ['createPeer', { ...peer, presharedKey: undefined }],
        ['createPeer', { ...peer, presharedKey: '********' }],
        ['createPeer', { ...peer, allowAddress: [] }],
        ['createPeer', { ...peer, allowAddress: ['192.0.2.2/33'] }],
        ['createPeer', { ...peer, allowAddress: ['2001:db8::/129'] }],
        ['createPeer', { ...peer, allowAddress: ['192.0.2.2/32/1'] }],
        ['createPeer', { ...peer, allowAddress: ['192.0.2.2/32', '192.0.2.2/32'] }],
        ['createPeer', { ...peer, keepAlive: -1 }],
        ['createPeer', { ...peer, endPoint: '192.0.2.3' }],
        ['createPeer', { ...peer, endPointPort: 51820 }],
        ['createPeer', { ...peer, endPoint: 'https://vpn.example', endPointPort: 51820 }],
        ['createPeer', { ...peer, endPoint: '999.1.1.1', endPointPort: 51820 }],
    ])('rejects invalid configuration before IO (%s)', async (operationId, body) => {
        const f = setup();
        await expect(f.run(operationId, body, {}, true)).rejects.toThrow();
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it('creates, modifies and deletes interfaces without claiming secret verification', async () => {
        const f = setup({ interfaces: [], maskKeys: true });
        expect(await f.run('createWireguard', iface)).toMatchObject({
            written: true,
            verified: false,
            notVerifiedFields: ['privateKey'],
            verification: { status: 'unknown', resourceId: 'new' },
        });
        expect(await f.run('modifyWireguard', { ...iface, status: false }, { id: 'new' })).toMatchObject({ written: true, verified: false });
        expect(await f.run('deleteWireguard', undefined, { id: 'new' })).toMatchObject({ written: true, verified: true });
        expect(f.writes()).toHaveLength(3);
        expect(f.writes()[0][0]).toMatchObject({ method: 'POST', url: '/openapi/v1/controller/sites/site/vpn/wireguards', data: iface });
        expect(f.writes()[1][0].data.privateKey).toBe(privateKey);
        expect(f.writes().every(([, retry]) => retry === false)).toBe(true);
    });
    it('creates, updates and deletes peers with exact allowed-address readback', async () => {
        const f = setup();
        expect(await f.run()).toMatchObject({ written: true, verified: true });
        expect(await f.run('modifyPeer', { ...peer, status: false, allowAddress: ['203.0.113.0/24'] }, { id: 'new' })).toMatchObject({
            written: true,
            verified: true,
        });
        expect(f.writes()[1][0]).toMatchObject({
            method: 'PUT',
            url: '/openapi/v1/controller/sites/site/vpn/wireguard-peers/new',
            data: { allowAddress: ['203.0.113.0/24'] },
        });
        expect(await f.run('deletePeer', undefined, { id: 'new' })).toMatchObject({ written: true, verified: true });
        expect(await setup({ extraReadback: true }).run()).toMatchObject({ verified: false, verification: { status: 'mismatch' } });
    });
    it('preserves known optional fields, permits explicit roaming and ignores read-only metadata', async () => {
        const f = setup({
            peers: [{ ...peer, id: 'old', endPoint: '192.0.2.3', endPointPort: 51820, comment: 'Keep me', interfaceName: 'Office tunnel' }],
        });
        expect(await f.run('modifyPeer', { ...peer, status: false }, { id: 'old' })).toMatchObject({ verified: true });
        expect(f.writes()[0][0].data).toMatchObject({ comment: 'Keep me', endPoint: '192.0.2.3', endPointPort: 51820 });
        expect(f.writes()[0][0].data).not.toHaveProperty('interfaceName');
        expect(await f.run('modifyPeer', { ...peer, endPoint: '' }, { id: 'old' })).toMatchObject({ verified: true });
        expect(f.writes()[1][0].data).not.toHaveProperty('endPointPort');
    });
    it('treats reordered allowed addresses and absent deletes as no-ops', async () => {
        const f = setup({ peers: [{ ...peer, id: 'old', allowAddress: [...peer.allowAddress].reverse() }] });
        expect(await f.run('modifyPeer', peer, { id: 'old' })).toMatchObject({ written: false, verified: true });
        expect(await f.run('deletePeer', undefined, { id: 'missing' })).toMatchObject({ written: false, verified: true });
        expect(await f.run('modifyWireguard', iface, { id: 'interface' })).toMatchObject({
            written: false,
            verified: false,
            notVerifiedFields: ['privateKey'],
        });
        expect(f.writes()).toHaveLength(0);
    });
    it('refuses unsafe references and conflicts before sending a mutation', async () => {
        for (const options of [
            { interfaces: [] },
            { incomplete: true },
            { drift: true },
            { peers: [{ ...peer, id: 'old' }] },
            { peers: [{ ...peer, id: 'old', name: 'Other peer' }] },
        ]) {
            const f = setup(options);
            await expect(f.run()).rejects.toThrow();
            expect(f.writes()).toHaveLength(0);
        }
        for (const patch of [
            { name: 'Other', localIp: '192.0.2.3' },
            { name: 'Other', listenPort: 51821 },
        ]) {
            const f = setup();
            await expect(f.run('createWireguard', { ...iface, ...patch })).rejects.toThrow('already in use');
            expect(f.writes()).toHaveLength(0);
        }
        for (const peers of [[{ ...peer, id: 'old', status: false }], [{ ...peer, id: 'old', interfaceId: undefined }]]) {
            const f = setup({ peers });
            await expect(f.run('deleteWireguard', undefined, { id: 'interface' })).rejects.toThrow('Delete referenced');
            expect(f.writes()).toHaveLength(0);
        }
    });
    it('reads every page and permits the same public key on a different interface', async () => {
        const peers = [1, 2, 3].map((n) => ({ ...peer, id: `old-${n}`, name: `Peer ${n}`, interfaceId: 'another-interface' }));
        const f = setup({ peers });
        expect(await f.run()).toMatchObject({ verified: true });
        expect(f.request.request.mock.calls.some(([config]) => config.params?.page === 2)).toBe(true);
    });
    it('requires advertised domain support but permits IP endpoints without it', async () => {
        const body = { ...peer, endPoint: 'vpn.example', endPointPort: 51820 };
        const f = setup();
        await expect(f.run('createPeer', body)).rejects.toThrow('domain endpoint support');
        expect(f.writes()).toHaveLength(0);
        expect(await setup({ supportDomain: true }).run('createPeer', body)).toMatchObject({ verified: true });
        expect(await setup().run('createPeer', { ...body, endPoint: '192.0.2.3' })).toMatchObject({ verified: true });
        expect(await setup().run('createPeer', { ...body, endPoint: '2001:db8::3' })).toMatchObject({ verified: true });
    });
    it('requires explicit secrets on updates and never verifies a nonempty preshared key', async () => {
        const f = setup({ peers: [{ ...peer, id: 'old' }], maskKeys: true });
        const { presharedKey: _key, ...withoutKey } = peer;
        await expect(f.run('modifyPeer', withoutKey, { id: 'old' })).rejects.toThrow();
        expect(f.request.request).not.toHaveBeenCalled();
        const result = await f.run('modifyPeer', { ...peer, presharedKey }, { id: 'old' });
        expect(result).toMatchObject({ written: true, verified: false, notVerifiedFields: ['presharedKey'] });
        expect(JSON.stringify(result)).not.toContain(presharedKey);
        expect(f.writes()[0][0].data.presharedKey).toBe(presharedKey);
    });
    it('reports uncertain outcomes without replay and redacts controller error echoes', async () => {
        expect(await setup({ missingReadback: true }).run()).toMatchObject({ verified: false, verification: { status: 'unknown' } });
        expect(await setup({ apply: false }).run()).toMatchObject({ verified: false, verification: { status: 'mismatch' } });
        const f = setup({ lost: true });
        expect(await f.run()).toMatchObject({ written: 'unknown', verified: true });
        expect(f.writes()).toHaveLength(1);
        await expect(setup({ reject: true }).run('createPeer', { ...peer, presharedKey })).rejects.toMatchObject({
            errorCode: -43208,
            message: 'Rejected [redacted]',
        });
    });
    it('requires security read/write access and prevents raw-call bypass in both API versions', async () => {
        const f = setup();
        for (const policy of [
            new ToolAccessPolicy('read-only'),
            new ToolAccessPolicy('full', 'security:r'),
            new ToolAccessPolicy('full', 'security:w'),
        ])
            await expect(f.run('createPeer', peer, {}, false, policy)).rejects.toThrow(/not permitted|Read-only/);
        const raw = new GenericOperations(f.request as never, (path) => `/openapi/v1/controller${path}`);
        for (const version of ['v1', 'v2'])
            for (const path of ['/sites/site/vpn/wireguards', '/sites/site/vpn/wireguard-peers/', '/sites/site/vpn/wireguard-peers/id'])
                await expect(raw.genericApiCall('POST', path, version, peer)).rejects.toThrow('executeApiOperation');
        expect(f.writes()).toHaveLength(0);
    });
    it('rejects noncanonical discovery aliases instead of falling back to unguarded writes', async () => {
        const path = '/openapi/v1/{omadacId}/sites/{siteId}/vpn/wireguard-peers';
        const alias = structuredClone(document);
        alias.paths[path.replace('/v1/', '/v2/')] = { post: { ...alias.paths[path].post, operationId: 'aliasCreatePeer' } };
        const f = setup();
        await expect(
            executeDiscoveredOperation(
                new OperationCatalog(alias, 'bundled'),
                f.request as never,
                { operationId: 'aliasCreatePeer', body: peer, dryRun: false },
                { omadacId: 'controller', siteId: 'site', readOnly: false, accessPolicy: new ToolAccessPolicy('full', 'security:rw') }
            )
        ).rejects.toThrow('canonical v1 managed resource');
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it('deletes orphaned peers without needing the former interface', async () => {
        const f = setup({ interfaces: [], peers: [{ ...peer, id: 'old' }] });
        expect(await f.run('deletePeer', undefined, { id: 'old' })).toMatchObject({ written: true, verified: true });
    });
    it('disables an orphaned peer without weakening reference checks for other edits or drift', async () => {
        const peers = [{ ...peer, id: 'old', endPoint: 'vpn.example', endPointPort: 51820 }];
        const f = setup({ interfaces: [], peers });
        expect(await f.run('modifyPeer', { ...peer, status: false }, { id: 'old' })).toMatchObject({ written: true, verified: true });
        expect(f.request.request.mock.calls.some(([config]) => config.url.endsWith('/wireguards'))).toBe(false);
        for (const patch of [{ name: 'Renamed' }, { publicKey: presharedKey }, { interfaceId: 'other' }, { presharedKey }]) {
            const edited = setup({ interfaces: [], peers });
            await expect(edited.run('modifyPeer', { ...peer, status: false, ...patch }, { id: 'old' })).rejects.toThrow('interface does not exist');
            expect(edited.writes()).toHaveLength(0);
        }
        const drift = setup({ interfaces: [], peers, drift: true });
        await expect(drift.run('modifyPeer', { ...peer, status: false }, { id: 'old' })).rejects.toThrow('changed during preflight');
        expect(drift.writes()).toHaveLength(0);
    });
});
