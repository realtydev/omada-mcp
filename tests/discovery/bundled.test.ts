import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { OperationCatalog } from '../../src/discovery/catalog.js';
import { type ExecuteApiOperationOptions, executeDiscoveredOperation } from '../../src/discovery/execute.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { ToolAccessPolicy } from '../../src/server/toolPolicy.js';

const catalog = new OperationCatalog(JSON.parse(readFileSync(new URL('../../docs/openapi/00-all.json', import.meta.url), 'utf8')), 'bundled');
const context = { omadacId: 'controller-1', siteId: 'site-1', readOnly: false };
const base = '/openapi/v1/controller-1/sites/site-1';
const mac = 'AA-BB-CC-DD-EE-02';
const ssidBasicConfig = {
    name: 'review-only',
    band: 1,
    security: 0,
    broadcast: true,
    guestNetEnable: false,
    vlanEnable: false,
    mloEnable: false,
    pmfMode: 3,
    enable11r: false,
};

function setup() {
    const request = {
        request: vi.fn().mockResolvedValue({ errorCode: 0, result: { data: [] } }),
        ensureSuccess: vi.fn((response: { result: unknown }) => response.result),
    };
    const run = (options: ExecuteApiOperationOptions, readOnly = false, accessPolicy?: ToolAccessPolicy) =>
        executeDiscoveredOperation(catalog, request as unknown as RequestHandler, options, { ...context, readOnly, accessPolicy });
    return { request, run };
}

describe('refreshed bundled contracts', () => {
    it.each([
        ['getSiteList', {}, '/openapi/v1/controller-1/sites'],
        ['getWifiSummary', { start: 100, end: 200 }, `${base}/dashboard/wifi-summary`],
        ['getSiteHealthTimeList', { start: 100, end: 200 }, `${base}/health/timeline`],
        ['getGridIncidentList', { 'filters.startTime': 100, 'filters.endTime': 200 }, `${base}/anomaly/incidents`],
        ['getGridLldpNeighborTable', { switchMac: mac }, `${base}/switches/${mac}/lldp-neighbors`],
        ['getGridWidsData', {}, `${base}/insight/wids`],
        ['getGridRogueAps', {}, `${base}/insight/rogueaps`],
    ])('executes the declared %s read with configured identifiers', async (operationId, params, path) => {
        const { request, run } = setup();
        const operation = catalog.describe(operationId, { readOnly: true });
        expect(operation.unsupportedReason).toBeUndefined();
        const result = await run({ operationId, params }, true);
        expect(result).toMatchObject({ source: 'bundled', written: false, request: { method: 'GET', path } });
        expect(request.request).toHaveBeenCalledOnce();
        expect(request.request.mock.calls[0][0]).toMatchObject({ method: 'GET', url: path });
        for (const name of ['page', 'pageSize']) {
            if (operation.parameters.some((p) => p.name === name && p.required)) {
                expect(result.request.query[name]).toBe(name === 'page' ? 1 : 100);
            }
        }
    });

    it('retains version-3 documentation while refusing every version-3 execution', async () => {
        const { request, run } = setup();
        const unsupported = catalog.operations.filter((operation) => operation.path.startsWith('/openapi/v3/'));
        expect(unsupported).toHaveLength(8);
        for (const operation of unsupported) {
            expect(catalog.describe(operation.operationId).unsupportedReason).toContain('v1/v2');
            await expect(run({ operationId: operation.operationId, dryRun: true })).rejects.toThrow('v1/v2');
        }
        expect(request.request).not.toHaveBeenCalled();
    });

    it('keeps a read-named POST out of the read-only catalog and blocks it before I/O', async () => {
        const { request, run } = setup();
        expect(catalog.get('getIncidentsRanking')?.method).toBe('POST');
        expect(catalog.search({ query: 'getIncidentsRanking', readOnly: true }).operations).not.toContainEqual(
            expect.objectContaining({ operationId: 'getIncidentsRanking' })
        );
        await expect(run({ operationId: 'getIncidentsRanking' }, true)).rejects.toThrow('Read-only profile');
        expect(request.request).not.toHaveBeenCalled();
    });

    it('blocks every bundled non-GET operation before I/O in read-only mode', async () => {
        const { request, run } = setup();
        const writes = catalog.operations.filter((operation) => operation.method !== 'GET');
        expect(writes.length).toBeGreaterThan(1000);
        for (const operation of writes) {
            await expect(run({ operationId: operation.operationId, dryRun: false }, true)).rejects.toThrow('Read-only profile');
        }
        expect(request.request).not.toHaveBeenCalled();
    });

    it('validates required incident time filters and caller-supplied identifiers before I/O', async () => {
        const { request, run } = setup();
        for (const params of [
            {},
            { 'filters.startTime': '100', 'filters.endTime': 200 },
            { 'filters.startTime': 100, 'filters.endTime': 200, omadacId: 'other' },
            { 'filters.startTime': 100, 'filters.endTime': 200, Cookie: 'private' },
        ]) {
            await expect(run({ operationId: 'getGridIncidentList', params })).rejects.toThrow();
        }
        expect(request.request).not.toHaveBeenCalled();
    });

    it('preserves category permission boundaries for new LLDP reads', async () => {
        const { request, run } = setup();
        const options = { operationId: 'getGridLldpNeighborTable', params: { switchMac: mac } };
        await expect(run(options, true, new ToolAccessPolicy('read-only', 'wireless:r'))).rejects.toThrow('not permitted');
        expect(request.request).not.toHaveBeenCalled();
        await run(options, true, new ToolAccessPolicy('read-only', 'switching:r'));
        expect(request.request).toHaveBeenCalledOnce();
    });

    it.each([
        ['updateSiteEntity', 'name', { name: 'Office', region: 'United States', scenario: 'Office', timeZone: 'America/New_York' }],
        ['createDhcpReservation', 'description', { mac, netId: 'lan-1', status: false, description: 'Office printer' }],
    ])('validates the bundled %s pattern during a dry run', async (operationId, field, body) => {
        const { request, run } = setup();
        await expect(run({ operationId, body, dryRun: true })).resolves.toMatchObject({ dryRun: true, written: false });
        await expect(run({ operationId, body: { ...body, [field]: '@invalid' }, dryRun: false })).rejects.toThrow(`data/body/${field} must match`);
        expect(request.request).not.toHaveBeenCalled();
    });

    it.each([
        ['modifyRadiosConfig', { apMac: mac }, {}, 'setApRadio'],
        ['modifyWlansConfigV2', { apMac: mac }, { ssidOverrides: [] }, 'updateApSsidOverride'],
        ['modifySwitchPort', { switchMac: mac, port: '1' }, { name: 'review-only' }, 'updateSwitchPort'],
        ['batchModifySwitchPort', { switchMac: mac }, { portList: [1], name: 'review-only' }, 'the guarded switch port tools'],
        ['batchModifySwitchesPortLag', {}, { selectAll: true, switchList: [] }, 'the guarded switch port tools'],
        [
            'modifyRateLimitProfile',
            { profileId: 'profile-1' },
            { name: 'review-only', downLimitEnable: false, upLimitEnable: false },
            'updateRateLimitProfile',
        ],
        ['createDhcpReservation', {}, { mac, netId: 'lan-1', status: false }, 'createDhcpReservation'],
        ['reservationFromDhcpUserList', {}, { selectMacs: { selectType: 'all' }, selectIps: [] }, 'createDhcpReservation'],
        ['updateSsidBasicConfig', { wlanId: 'wlan-1', ssidId: 'ssid-1' }, ssidBasicConfig, 'updateSsid'],
        ['updateSsidBasicConfigBySite', { ssidId: 'ssid-1' }, ssidBasicConfig, 'updateSsid'],
    ])('preserves dedicated verification for bundled %s', async (operationId, params, body, preferredTool) => {
        const { request, run } = setup();
        const preview = await run({ operationId, params, body });
        expect(preview).toMatchObject({ dryRun: true, written: false, verified: false });
        expect(preview.warning).toContain(preferredTool);
        await expect(run({ operationId, params, body, dryRun: false })).rejects.toThrow(preferredTool);
        await expect(run({ operationId, params, body }, true)).rejects.toThrow('Read-only profile');
        expect(request.request).not.toHaveBeenCalled();
    });

    it.each([
        ['modifySwitchStackPortSetting', { stackId: 'stack-1', port: '2' }, { disable: true }],
        ['modifyOswStackPort', { stackId: 'stack-1', port: '2' }, { profileOverrideEnable: true }],
        ['batchModifyOswStackPorts', { stackId: 'stack-1' }, { unitList: [{ mac, unit: 1, portList: [{ unit: 1, slot: 0, port: 2 }] }] }],
        ['batchModifySwitchStackPortSetting', { stackId: 'stack-1' }, { unitList: [{ mac, unit: 1, portList: [{ unit: 1, slot: 0, port: 2 }] }] }],
        ['modifySwitchStackLagSetting', { stackId: 'stack-1', lagId: '1' }, {}],
        ['modifyOswStackLag', { stackId: 'stack-1', lagId: '1' }, { profileOverrideEnable: true }],
        ['deleteSwitchStackLagSetting', { stackId: 'stack-1', lagId: '1' }, undefined],
        ['deleteOswStackLag', { stackId: 'stack-1', lagId: '1' }, undefined],
    ])('previews %s but refuses unsupported stack port/LAG writes before I/O', async (operationId, params, body) => {
        const { request, run } = setup();
        const options = { operationId, params, ...(body === undefined ? {} : { body }) };
        const preview = await run(options);
        expect(preview).toMatchObject({ dryRun: true, written: false, verified: false });
        expect(preview.warning).toContain('unsupported until guarded stack identity');
        await expect(run({ ...options, dryRun: false })).rejects.toThrow('unsupported until guarded stack identity');
        await expect(run(options, true)).rejects.toThrow('Read-only profile');
        expect(request.request).not.toHaveBeenCalled();
    });
});
