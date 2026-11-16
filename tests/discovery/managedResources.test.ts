import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import { readResourceRows } from '../../src/discovery/managedResources.js';
import { GenericOperations } from '../../src/omadaClient/generic.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const catalog = new OperationCatalog(JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8')), 'bundled');
const context = { omadacId: 'controller', siteId: 'site', readOnly: false };
const ssid = {
    name: 'Guest',
    deviceType: 1,
    ssidEnable: false,
    band: 3,
    broadcast: true,
    security: 0,
    guestNetEnable: true,
    enable11r: false,
    hidePwd: true,
    mloEnable: false,
    pmfMode: 3,
    vlanEnable: false,
};
const route = {
    name: 'WAN route',
    status: false,
    protocols: [6],
    interfaceType: 0,
    interfaceId: 'wan',
    backupInterface: false,
    sourceType: 0,
    sourceIds: ['lan'],
    destinationType: 0,
    destinationIds: ['lan'],
};
type Row = Record<string, unknown>;
function fixture(
    initial: Row[] = [],
    options: { lost?: boolean; reject?: boolean; drift?: boolean; detailMissing?: boolean; refs?: Row[]; malformed?: boolean; primary?: boolean } = {}
) {
    let rows = structuredClone(initial),
        reads = 0;
    const request = {
        request: vi.fn((config) => {
            if (config.method === 'GET') {
                if (config.url.endsWith('/lan-networks') || config.url.includes('/profiles/groups/'))
                    return { errorCode: 0, result: options.refs ?? [{ id: 'lan' }] };
                if (config.url.endsWith('/wireless-network/wlans') && !rows.some((row) => row.kind === 'wlan'))
                    return { errorCode: 0, result: [{ id: 'wlan', name: 'Existing', primary: options.primary ?? false }] };
                if (/\/ssids\/[^/]+$/.test(config.url))
                    return {
                        errorCode: 0,
                        result: options.detailMissing ? { id: 'new', name: 'Guest' } : rows.find((row) => config.url.endsWith(`/${row.id}`)),
                    };
                reads++;
                if (options.malformed) return { errorCode: 0, result: { data: rows, totalRows: rows.length + 1 } };
                if (options.drift && reads === 2) rows = [...rows, { id: 'unexpected', name: 'Concurrent' }];
                return { errorCode: 0, result: { data: rows, totalRows: rows.length, currentPage: config.params?.page ?? 1 } };
            }
            if (options.reject) return { errorCode: -1, msg: 'rejected' };
            if (config.method === 'POST')
                rows = [...rows, { ...config.data, id: 'new', ...(config.url.endsWith('/wlans') ? { kind: 'wlan', primary: false } : {}) }];
            else if (config.method === 'DELETE') rows = rows.filter((row) => !config.url.endsWith(`/${row.id}`));
            else rows = rows.map((row) => (config.url.endsWith(`/${row.id}`) ? { ...row, ...config.data } : row));
            if (options.lost) throw new Error('connection lost after applying');
            return { errorCode: 0, result: config.method === 'POST' ? { id: 'new' } : {} };
        }),
        ensureSuccess: vi.fn((response) => {
            if (response.errorCode !== 0) throw Object.assign(new Error(response.msg), { errorCode: response.errorCode });
            return response.result;
        }),
    };
    const run = (operationId: string, body?: unknown, params = {}, dryRun = false, accessPolicy?: ToolAccessPolicy) =>
        executeDiscoveredOperation(
            catalog,
            request as unknown as RequestHandler,
            { operationId, ...(body === undefined ? {} : { body }), params, dryRun },
            { ...context, accessPolicy }
        );
    const writes = () => request.request.mock.calls.filter(([config]) => config.method !== 'GET');
    return { request, run, writes };
}

describe('managed lifecycle and policy routes through discovery', () => {
    it('creates, renames and deletes an empty non-primary WLAN group', async () => {
        let groups: Row[] = [{ id: 'default', name: 'Default', primary: true }];
        const request = {
            request: vi.fn((config) => {
                if (config.method === 'GET') return { errorCode: 0, result: config.url.endsWith('/ssids') ? { data: [], totalRows: 0 } : groups };
                if (config.method === 'POST') groups = [...groups, { ...config.data, id: 'new', primary: false }];
                if (config.method === 'PATCH') groups = groups.map((row) => (row.id === 'new' ? { ...row, ...config.data } : row));
                if (config.method === 'DELETE') groups = groups.filter((row) => row.id !== 'new');
                return { errorCode: 0, result: {} };
            }),
            ensureSuccess: (response: { result: unknown }) => response.result,
        };
        for (const options of [
            { operationId: 'createWlanGroup', body: { name: 'New group', clone: false } },
            { operationId: 'updateWlanGroup', params: { wlanId: 'new' }, body: { name: 'Renamed' } },
            { operationId: 'deleteWlanGroup', params: { wlanId: 'new' } },
        ])
            expect(await executeDiscoveredOperation(catalog, request as never, { ...options, dryRun: false }, context)).toMatchObject({
                written: true,
                verified: true,
            });
        expect(groups).toEqual([{ id: 'default', name: 'Default', primary: true }]);
        expect(request.request.mock.calls.filter(([config]) => config.method !== 'GET')).toHaveLength(3);
    });
    it('creates and deletes an SSID with identity and detail readback', async () => {
        const f = fixture();
        expect(await f.run('createSsid', ssid, { wlanId: 'wlan' })).toMatchObject({
            written: true,
            verified: true,
            verification: { resourceId: 'new' },
        });
        expect(await f.run('deleteSsid', undefined, { wlanId: 'wlan', ssidId: 'new' })).toMatchObject({ written: true, verified: true });
        expect(await f.run('deleteSsid', undefined, { wlanId: 'wlan', ssidId: 'new' })).toMatchObject({ written: false, verified: true });
        expect(f.writes()).toHaveLength(2);
        expect(f.writes().every(([, retry]) => retry === false)).toBe(true);
    });
    it('previews locally, redacts keys, and retains submitted secrets for execution', async () => {
        const f = fixture();
        const body = { ...ssid, security: 3, pskSetting: { securityKey: 'secret-value', versionPsk: 2, encryptionPsk: 3, gikRekeyPskEnable: false } };
        const preview = await f.run('createSsid', body, { wlanId: 'wlan' }, true);
        expect(preview).toMatchObject({ dryRun: true, written: false });
        expect(JSON.stringify(preview)).not.toContain('secret-value');
        expect(f.request.request).not.toHaveBeenCalled();
        expect(await f.run('createSsid', body, { wlanId: 'wlan' })).toMatchObject({ verified: false, notVerifiedFields: ['pskSetting.securityKey'] });
        expect(f.writes()[0][0].data.pskSetting.securityKey).toBe('secret-value');
    });
    it('reports missing detail evidence and lost acknowledgements honestly', async () => {
        expect(await fixture([], { detailMissing: true }).run('createSsid', ssid, { wlanId: 'wlan' })).toMatchObject({
            written: true,
            verified: false,
            verification: { status: 'unknown' },
        });
        const lost = fixture([], { lost: true });
        expect(await lost.run('createSsid', ssid, { wlanId: 'wlan' })).toMatchObject({ written: 'unknown', verified: true });
        expect(lost.writes()).toHaveLength(1);
    });
    it('rejects conflicts, incomplete inventories, drift and missing references before mutation', async () => {
        for (const f of [
            fixture([{ id: 'existing', name: route.name }]),
            fixture([], { drift: true }),
            fixture([], { refs: [] }),
            fixture([], { malformed: true }),
        ]) {
            await expect(f.run('createPolicyRouting', route)).rejects.toThrow();
            expect(f.writes()).toHaveLength(0);
        }
    });
    it('creates, preserves optional configuration on update, and deletes policy routes', async () => {
        const f = fixture();
        expect(await f.run('createPolicyRouting', route)).toMatchObject({ verified: true });
        const { interfaceId: _id, interfaceType: _type, ...patch } = route;
        // The interface must be explicit at preview time, even when other optional settings are preserved.
        expect(
            await f.run('modifyPolicyRouting', { ...patch, interfaceId: 'wan', interfaceType: 0, name: 'Updated' }, { policyRoutingId: 'new' })
        ).toMatchObject({ verified: true });
        expect(await f.run('deletePolicyRouting', undefined, { policyRoutingId: 'new' })).toMatchObject({ verified: true });
        expect(f.writes()).toHaveLength(3);
    });
    it('validates policy conditions and scope before writes', async () => {
        const f = fixture();
        for (const body of [
            { ...route, sourceIds: [] },
            { ...route, interfaceType: 4 },
            { ...route, destinationType: 9 },
        ])
            await expect(f.run('createPolicyRouting', body)).rejects.toThrow();
        await expect(f.run('createPolicyRouting', route, {}, false, new ToolAccessPolicy('full', 'network:w'))).rejects.toThrow('not permitted');
        expect(f.writes()).toHaveLength(0);
    });
    it('resolves IP and IP-port references with schema-valid group path parameters', async () => {
        const f = fixture();
        expect(await f.run('createPolicyRouting', { ...route, sourceType: 1, destinationType: 2 })).toMatchObject({ verified: true });
        const paths = f.request.request.mock.calls.map(([config]) => config.url);
        expect(paths).toContain('/openapi/v1/controller/sites/site/profiles/groups/0');
        expect(paths).toContain('/openapi/v1/controller/sites/site/profiles/groups/1');
    });
    it('does not swallow a controller rejection or replay the mutation', async () => {
        const f = fixture([], { reject: true });
        await expect(f.run('createPolicyRouting', route)).rejects.toMatchObject({ errorCode: -1 });
        expect(f.writes()).toHaveLength(1);
    });
    it('refuses unsafe WLAN cloning and deletion of default or nonempty groups', async () => {
        const f = fixture();
        await expect(f.run('createWlanGroup', { name: 'Copied', clone: true, clonedWlanId: 'wlan' })).rejects.toThrow('clone:false');
        const primary = fixture([{ id: 'wlan', name: 'Default', primary: true, kind: 'wlan' }]);
        await expect(primary.run('deleteWlanGroup', undefined, { wlanId: 'wlan' })).rejects.toThrow('Default');
        expect(primary.writes()).toHaveLength(0);
        const group = fixture([{ id: 'wlan', name: 'Existing', primary: false, kind: 'wlan' }]);
        await expect(group.run('deleteWlanGroup', undefined, { wlanId: 'wlan' })).rejects.toThrow('Delete SSIDs explicitly');
    });
    it('rejects raw calls and unsupported lifecycle aliases instead of bypassing the workflow', async () => {
        const f = fixture();
        const generic = new GenericOperations(f.request as never, (path) => `/openapi/v1/controller${path}`);
        await expect(generic.genericApiCall('POST', '/sites/site/routing/policy-routings', 'v1', route)).rejects.toThrow('executeApiOperation');
        expect(f.writes()).toHaveLength(0);
    });
    it('does not treat repeated, conflicting or truncated collections as complete', async () => {
        await expect(readResourceRows(async () => ({ data: [{ id: 'same' }], totalRows: 2 }))).rejects.toThrow('repeated');
        await expect(readResourceRows(async () => [{ id: 'a', ssidId: 'b' }], ['ssidId'])).rejects.toThrow('conflicting');
        await expect(readResourceRows(async () => ({ data: [], totalRows: 1 }))).rejects.toThrow('early');
    });
});
