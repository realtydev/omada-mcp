import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import { GenericOperations } from '../../src/omadaClient/generic.js';
import { categoryForPath, ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const document = JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8'));
const catalog = new OperationCatalog(document, 'bundled');
const mac = 'AA-BB-CC-DD-EE-01';
const body = { name: 'Office power', status: true, turnOnTime: 'office-hours', poePortsMap: { [mac]: [1, 2] } };
type Row = Record<string, unknown> & { id: string };
function setup(
    options: {
        initial?: Row[];
        devices?: unknown;
        profiles?: unknown;
        drift?: boolean;
        lost?: boolean;
        reject?: boolean;
        apply?: boolean;
        incomplete?: boolean;
        foreign?: boolean;
        missingReadback?: boolean;
        extraReadback?: boolean;
    } = {}
) {
    let rows = structuredClone(options.initial ?? []),
        listReads = 0,
        sent = false;
    const request = {
        request: vi.fn((config, _retry?: boolean) => {
            if (config.method === 'GET') {
                if (config.url.endsWith('/time-range-profiles'))
                    return { errorCode: 0, result: options.profiles ?? [{ profileId: 'office-hours', name: 'Office hours' }] };
                if (config.url.endsWith('/poe-ports'))
                    return {
                        errorCode: 0,
                        result: options.devices ?? [{ type: 'switch', mac, site: 'site', poePort: { portNum: 8, poePortIds: [1, 2, 3, 4] } }],
                    };
                listReads++;
                if (options.drift && listReads === 2) rows = [...rows, { ...body, id: 'concurrent', name: 'Concurrent', status: false }];
                let data = rows.slice((config.params.page - 1) * 2, config.params.page * 2);
                if (sent && options.missingReadback) data = data.map(({ poePortsMap: _ports, ...row }) => row);
                if (sent && options.extraReadback)
                    data = data.map((row) => ({ ...row, poePortsMap: { ...(row.poePortsMap as object), 'AA-BB-CC-DD-EE-02': [3] } }));
                if (options.foreign) data = data.map((row) => ({ ...row, siteId: 'another-site' }));
                return { errorCode: 0, result: { data, currentPage: config.params.page, totalRows: rows.length + (options.incomplete ? 1 : 0) } };
            }
            sent = true;
            if (options.reject) return { errorCode: -33603, msg: 'Source entry does not exist' };
            if (options.apply !== false) {
                if (config.method === 'POST') rows.push({ ...config.data, id: 'new', nextExecute: 123 });
                if (config.method === 'PUT')
                    rows = rows.map((row) => (config.url.endsWith(`/${row.id}`) ? { ...row, ...config.data, nextExecute: 456 } : row));
                if (config.method === 'DELETE') rows = rows.filter((row) => !config.url.endsWith(`/${row.id}`));
            }
            if (options.lost) throw new Error('lost acknowledgement');
            return { errorCode: 0 };
        }),
        ensureSuccess: (response: { errorCode: number; msg?: string; result?: unknown }) => {
            if (response.errorCode !== 0) throw Object.assign(new Error(response.msg), { errorCode: response.errorCode });
            return response.result;
        },
    };
    const run = (
        operationId = 'createPoeSchedule',
        payload: unknown = operationId === 'createPoeSchedule' ? body : undefined,
        params: Record<string, unknown> = {},
        dryRun = false,
        policy = new ToolAccessPolicy('full', 'switching:rw,network:r')
    ) =>
        executeDiscoveredOperation(
            catalog,
            request as never,
            { operationId, ...(payload === undefined ? {} : { body: payload }), params, dryRun },
            { omadacId: 'controller', siteId: 'site', readOnly: false, accessPolicy: policy }
        );
    return { request, run, writes: () => request.request.mock.calls.filter(([config]) => config.method !== 'GET') };
}

describe('managed PoE schedules', () => {
    it('previews without HTTP and validates missing vendor constraints before preview', async () => {
        const f = setup();
        expect(await f.run('createPoeSchedule', body, {}, true)).toMatchObject({
            written: false,
            dryRun: true,
            warning: expect.stringContaining('interrupt power'),
        });
        for (const patch of [
            { turnOnTime: '' },
            { poePortsMap: {} },
            { poePortsMap: { [mac]: [] } },
            { poePortsMap: { [mac]: [0] } },
            { poePortsMap: { invalid: [1] } },
            { poePortsMap: { [mac]: [1], 'aa:bb:cc:dd:ee:01': [2] } },
            { siteId: 'other' },
        ])
            await expect(f.run('createPoeSchedule', { ...body, ...patch }, {}, true)).rejects.toThrow();
        expect(f.request.request).not.toHaveBeenCalled();
    });
    it('creates, updates, disables and deletes through the existing verified executor', async () => {
        const f = setup();
        expect(await f.run()).toMatchObject({ written: true, verified: true, verification: { resourceId: 'new' } });
        expect(await f.run('modifyPoeSchedule', { ...body, name: 'Evening power', status: false }, { poeScheduleId: 'new' })).toMatchObject({
            written: true,
            verified: true,
        });
        expect(await f.run('deletePoeSchedule', undefined, { poeScheduleId: 'new' })).toMatchObject({ written: true, verified: true });
        expect(f.writes()).toHaveLength(3);
        expect(f.writes().every(([, retry]) => retry === false)).toBe(true);
        expect(f.writes()[0][0]).toMatchObject({ method: 'POST', url: '/openapi/v1/controller/sites/site/poe-schedules', data: body });
        expect(f.writes()[1][0].data).not.toHaveProperty('nextExecute');
    });
    it('compares MAC identity and port sets without false no-op writes', async () => {
        const f = setup({ initial: [{ ...body, id: 'old', poePortsMap: { 'aa:bb:cc:dd:ee:01': [2, 1] } }] });
        expect(await f.run('modifyPoeSchedule', body, { poeScheduleId: 'old' })).toMatchObject({ written: false, verified: true });
        expect(await f.run('deletePoeSchedule', undefined, { poeScheduleId: 'missing' })).toMatchObject({ written: false, verified: true });
        expect(f.writes()).toHaveLength(0);
    });
    it('removes omitted target devices and rejects unexpected read-back targets', async () => {
        const f = setup({ initial: [{ ...body, id: 'old', poePortsMap: { ...body.poePortsMap, 'AA-BB-CC-DD-EE-02': [3] } }] });
        expect(await f.run('modifyPoeSchedule', body, { poeScheduleId: 'old' })).toMatchObject({ written: true, verified: true });
        expect(f.writes()[0][0].data.poePortsMap).toEqual(body.poePortsMap);
        expect(await setup({ extraReadback: true }).run()).toMatchObject({ verified: false, verification: { status: 'mismatch' } });
    });
    it('uses explicit gateway PoE port IDs and preserves the selected site on update', async () => {
        const f = setup({
            initial: [{ ...body, id: 'old', siteId: 'site' }],
            devices: [{ mac, type: 'gateway', site: 'site', poePort: { poePortIds: [1, 2] } }],
        });
        expect(await f.run('modifyPoeSchedule', { ...body, name: 'Renamed' }, { poeScheduleId: 'old' })).toMatchObject({ verified: true });
        expect(f.writes()[0][0].data.siteId).toBe('site');
    });
    it.each([
        { profiles: [] },
        { devices: [] },
        { devices: [{ mac, type: 'switch', poePort: { portNum: 8 } }] },
        { devices: [{ mac, type: 'switch', poePort: { poePortIds: [1] } }] },
        { devices: [{ mac, type: 'switch', site: 'other', poePort: { poePortIds: [1, 2] } }] },
        { devices: [{ mac, type: 'stack', poePort: { poePortIds: [1, 2] } }] },
        { devices: [{ mac }, { mac: 'aa:bb:cc:dd:ee:01' }] },
        { incomplete: true },
        { drift: true },
    ])('refuses missing, ambiguous or changing evidence %j', async (options) => {
        const f = setup(options);
        await expect(f.run()).rejects.toThrow();
        expect(f.writes()).toHaveLength(0);
    });
    it('rejects foreign-site inventories, duplicate names and active port conflicts', async () => {
        for (const options of [
            { initial: [{ ...body, id: 'other', name: 'Other power' }] },
            { initial: [{ ...body, id: 'other', status: false }] },
            { initial: [{ ...body, id: 'other' }], foreign: true },
        ]) {
            const f = setup(options);
            await expect(f.run()).rejects.toThrow();
            expect(f.writes()).toHaveLength(0);
        }
    });
    it('checks every page and allows inactive schedules to share ports', async () => {
        const initial = [1, 2, 3].map((n) => ({ ...body, id: `old-${n}`, name: `Inactive ${n}`, status: false }));
        const f = setup({ initial });
        expect(await f.run()).toMatchObject({ verified: true });
        expect(f.request.request.mock.calls.some(([config]) => config.params?.page === 2)).toBe(true);
    });
    it('allows deletion even when port or time-range references are unavailable', async () => {
        const f = setup({ initial: [{ ...body, id: 'old' }], profiles: [], devices: [] });
        expect(await f.run('deletePoeSchedule', undefined, { poeScheduleId: 'old' })).toMatchObject({ verified: true });
    });
    it('allows a disable-only update with unavailable references but still checks drift and target edits', async () => {
        const initial = [{ ...body, id: 'old' }];
        const f = setup({ initial, profiles: [], devices: [] });
        expect(
            await f.run(
                'modifyPoeSchedule',
                { ...body, status: false },
                { poeScheduleId: 'old' },
                false,
                new ToolAccessPolicy('full', 'switching:rw')
            )
        ).toMatchObject({ written: true, verified: true });
        expect(
            f.request.request.mock.calls.every(([config]) => !config.url.endsWith('/time-range-profiles') && !config.url.endsWith('/poe-ports'))
        ).toBe(true);
        const drift = setup({ initial, drift: true, profiles: [], devices: [] });
        await expect(drift.run('modifyPoeSchedule', { ...body, status: false }, { poeScheduleId: 'old' })).rejects.toThrow(
            'changed during preflight'
        );
        expect(drift.writes()).toHaveLength(0);
        const modified = setup({ initial, profiles: [], devices: [] });
        await expect(
            modified.run('modifyPoeSchedule', { ...body, status: false, turnOnTime: 'another-profile' }, { poeScheduleId: 'old' })
        ).rejects.toThrow('does not exist');
        expect(modified.writes()).toHaveLength(0);
    });
    it('reports missing readback, mismatches and lost acknowledgements without replay', async () => {
        expect(await setup({ missingReadback: true }).run()).toMatchObject({ written: true, verified: false, verification: { status: 'unknown' } });
        expect(await setup({ apply: false }).run()).toMatchObject({ written: true, verified: false, verification: { status: 'mismatch' } });
        const f = setup({ lost: true });
        expect(await f.run()).toMatchObject({ written: 'unknown', verified: true });
        expect(f.writes()).toHaveLength(1);
        await expect(setup({ reject: true }).run()).rejects.toMatchObject({ errorCode: -33603 });
    });
    it('requires scoped reads and writes and prevents raw-call bypass', async () => {
        expect(categoryForPath('/openapi/v1/{omadacId}/sites/{siteId}/poe-schedules')).toBe('switching');
        const f = setup();
        for (const policy of [
            new ToolAccessPolicy('read-only'),
            new ToolAccessPolicy('full', 'switching:r,network:r'),
            new ToolAccessPolicy('full', 'switching:w,network:r'),
            new ToolAccessPolicy('full', 'switching:rw'),
        ])
            await expect(f.run('createPoeSchedule', body, {}, false, policy)).rejects.toThrow(/not permitted|Read-only/);
        const raw = new GenericOperations(f.request as never, (path) => `/openapi/v1/controller${path}`);
        for (const path of ['/sites/site/poe-schedules', '/sites/site/poe-schedules/', '/sites/site/poe-schedules/id'])
            await expect(raw.genericApiCall('POST', path, 'v1', body)).rejects.toThrow('executeApiOperation');
        expect(f.writes()).toHaveLength(0);
    });
});
