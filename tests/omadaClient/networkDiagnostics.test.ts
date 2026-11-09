import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkDiagnosticsOperations } from '../../src/omadaClient/networkDiagnostics.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const NOW = 1_800_000_000_000;
const TIME = NOW / 1000 - 60;
const MAC = 'AA-BB-CC-DD-EE-FF';
const payloads: Record<string, unknown> = {
    'traffic-activities': {
        apTrafficActivities: [{ time: TIME, txData: 2, rxData: 0 }],
        switchTrafficActivities: [{ time: TIME, txData: null, rxData: 4 }],
    },
    channels: {
        '2g channel stat': [],
        '5g channel stat': [{ channel: 36, apNum: 1, clientNum: 2, channelUtilization: 15 }],
        '6g channel stat': [],
    },
    'top-interference': {
        apInterference2g: [],
        apInterference5g: [{ mac: MAC, name: 'AP', interUtil: 18 }],
        apInterference5g2: [],
        apInterference6g: [],
    },
    'retry-dropped-rate': {
        retryEaps: [{ apMac: MAC, avg: 1, retries: [{ time: TIME, retryTimes: 2, retryRate: 0.1 }] }],
        droppedEaps: [{ apMac: MAC, avg: 0, dropouts: [{ time: TIME, dropTimes: 0, dropRate: 0 }] }],
    },
    statistics: { status: 1, wirelessLinked: false, childAps: [], candidateParents: [] },
    'wan-status': [{ port: 1, name: 'WAN', status: 1, internetState: 1, latency: 5, loss: 0 }],
    'isp-load': [{ portId: 1, portName: 'WAN', data: [{ time: TIME, totalRate: 32, latency: 5 }] }],
    details: { wanDetails: [{ port: 1, name: 'WAN', latency: 5, loss: 0 }] },
};
function setup() {
    const request = {
        request: vi.fn(),
        ensureSuccess: vi.fn((response) => {
            if (response.errorCode !== 0) throw new Error(response.msg);
            return response.result;
        }),
    };
    request.request.mockImplementation(async ({ url }: { url: string }) => ({ errorCode: 0, result: payloads[url.split('/').at(-1) ?? ''] }));
    const site = { resolveSiteId: vi.fn((value?: string) => value ?? 'default-site') };
    const operations = new NetworkDiagnosticsOperations(
        request as unknown as RequestHandler,
        site as unknown as SiteOperations,
        (path) => `/openapi/v1/controller${path}`
    );
    return { request, site, operations };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('bounded network diagnostic workflows', () => {
    it('preserves real traffic timestamps, null and zero without inventing totals', async () => {
        const { request, operations } = setup();
        const result = await operations.getTrafficHistory({ siteId: 'site/id' });
        expect(result).toMatchObject({
            source: 'controller-api',
            collectionComplete: true,
            queryWindow: { start: NOW / 1000 - 3600, end: NOW / 1000, unit: 'seconds' },
        });
        expect(result.sections.traffic).toMatchObject({
            status: 'ok',
            data: {
                apTrafficActivities: { data: [{ time: TIME, txData: 2, rxData: 0 }] },
                switchTrafficActivities: { data: [{ time: TIME, txData: null, rxData: 4 }] },
            },
        });
        expect(request.request).toHaveBeenCalledExactlyOnceWith({
            method: 'GET',
            url: '/openapi/v1/controller/sites/site%2Fid/dashboard/traffic-activities',
            params: { start: NOW / 1000 - 3600, end: NOW / 1000 },
            maxContentLength: 8 * 1024 * 1024,
        });
    });
    it('accepts the controller dxData spelling without renaming original sample fields', async () => {
        const { request, operations } = setup();
        request.request.mockResolvedValue({
            errorCode: 0,
            result: { apTrafficActivities: [{ time: TIME, txData: 2, dxData: 3 }], switchTrafficActivities: [] },
        });
        const result = await operations.getTrafficHistory();
        expect(result.sections.traffic).toMatchObject({
            status: 'ok',
            data: { apTrafficActivities: { data: [{ time: TIME, txData: 2, dxData: 3 }], sourceAliases: { rxData: 'dxData' } } },
        });
        expect(result.collectionComplete).toBe(true);
    });
    it('preserves channel-only rows as explicit partial evidence with live channel-group names', async () => {
        const { request, operations } = setup();
        request.request.mockImplementation(async ({ url }: { url: string }) => ({
            errorCode: 0,
            result: url.endsWith('/channels')
                ? {
                      channels2g: [{ channel: 1, apNum: 1, wrNum: 0, clientNum: 2, channelUtilization: 15 }],
                      channels5g: [{ channel: 36 }],
                      channels6g: [],
                  }
                : payloads[url.split('/').at(-1) ?? ''],
        }));
        const result = await operations.diagnoseWifi();
        expect(result.sections.channels).toMatchObject({
            status: 'partial',
            data: {
                channels2g: [{ channel: 1, metricsAvailable: true }],
                channels5g: [{ channel: 36, metricsAvailable: false, missingMetrics: ['apNum', 'clientNum', 'channelUtilization'] }],
            },
            missing: ['channels5g:metrics'],
        });
        expect(result.collectionComplete).toBe(false);
    });
    it('preserves unknown channel utilization as null and marks the band partial', async () => {
        const { request, operations } = setup();
        request.request.mockImplementation(async ({ url }: { url: string }) => ({
            errorCode: 0,
            result: url.endsWith('/channels')
                ? {
                      channels2g: [{ channel: 1, apNum: 1, clientNum: 0, channelUtilization: null }],
                      channels5g: [],
                      channels6g: [],
                  }
                : payloads[url.split('/').at(-1) ?? ''],
        }));
        expect((await operations.diagnoseWifi()).sections.channels).toMatchObject({
            status: 'partial',
            data: { channels2g: [{ channelUtilization: null, metricsAvailable: false }] },
        });
    });
    it('accepts live WAN health arrays as well as documented wrapped lists', async () => {
        const { request, operations } = setup();
        request.request.mockImplementation(async ({ url }: { url: string }) => ({
            errorCode: 0,
            result: url.endsWith('/details') ? [{ port: 1, latency: 7, loss: 0 }] : payloads[url.split('/').at(-1) ?? ''],
        }));
        const result = await operations.diagnoseWan({ gatewayMac: MAC });
        expect(result.sections.health).toMatchObject({ status: 'ok', data: [{ port: 1, latency: 7, loss: 0 }] });
        expect(result.collectionComplete).toBe(true);
    });
    it('bounds combined traffic histories and reports available/returned counts', async () => {
        const { operations } = setup();
        const result = await operations.getTrafficHistory({ maxSamples: 1 });
        expect(result.collectionComplete).toBe(false);
        expect(result.sections.traffic).toMatchObject({
            status: 'ok',
            truncated: true,
            data: {
                apTrafficActivities: { availableSamples: 1, returnedSamples: 1, truncated: false },
                switchTrafficActivities: { data: [], availableSamples: 1, returnedSamples: 0, truncated: true },
            },
        });
    });
    it('collects current RF snapshots plus timed retry/drop histories without scan requests', async () => {
        const { operations, request } = setup();
        const result = await operations.diagnoseWifi({ apMac: MAC, start: TIME - 60, end: TIME });
        expect(result.collectionComplete).toBe(true);
        expect(Object.keys(result.sections)).toEqual(['channels', 'interference', 'wirelessRates', 'mesh']);
        expect(request.request).toHaveBeenCalledTimes(4);
        expect(request.request.mock.calls.every(([config]) => config.method === 'GET')).toBe(true);
        const configs = request.request.mock.calls.map(([config]) => config);
        expect(configs.find((config) => config.url.endsWith('channels')).params).toBeUndefined();
        expect(configs.find((config) => config.url.endsWith('top-interference')).params).toBeUndefined();
        expect(configs.find((config) => config.url.endsWith('retry-dropped-rate')).params).toEqual({ start: TIME - 60, end: TIME });
        expect(configs.find((config) => config.url.endsWith('mesh/statistics')).url).toContain(MAC);
        expect(result.sections.wirelessRates).toMatchObject({
            data: { droppedEaps: [{ avg: 0, dropouts: { data: [{ time: TIME, dropTimes: 0, dropRate: 0 }] } }] },
        });
    });
    it('retains available RF bands and identifies omitted bands as partial evidence', async () => {
        const { request, operations } = setup();
        request.request.mockImplementation(async ({ url }: { url: string }) => ({
            errorCode: 0,
            result: url.endsWith('channels') ? { '2g channel stat': [] } : payloads[url.split('/').at(-1) ?? ''],
        }));
        const result = await operations.diagnoseWifi();
        expect(result.sections.channels).toMatchObject({
            status: 'partial',
            data: { '2g channel stat': [] },
            missing: ['5g channel stat', '6g channel stat'],
        });
        expect(result.sections.interference.status).toBe('ok');
        expect(result.collectionComplete).toBe(false);
    });
    it('keeps successful sections when one RF request fails', async () => {
        const { request, operations } = setup();
        request.request.mockImplementation(async ({ url }: { url: string }) => {
            await Promise.resolve();
            if (url.endsWith('top-interference')) throw new Error('HTTP 403');
            return { errorCode: 0, result: payloads[url.split('/').at(-1) ?? ''] };
        });
        const result = await operations.diagnoseWifi();
        expect(result.sections.interference).toMatchObject({ status: 'error', message: 'HTTP 403' });
        expect(result.sections.channels.status).toBe('ok');
        expect(result.collectionComplete).toBe(false);
    });
    it('does not accept a retry entry carrying only a dropout series', async () => {
        const { request, operations } = setup();
        request.request.mockImplementation(async ({ url }: { url: string }) => ({
            errorCode: 0,
            result: url.endsWith('retry-dropped-rate')
                ? { retryEaps: [{ apMac: MAC, avg: 1, dropouts: [] }], droppedEaps: [] }
                : payloads[url.split('/').at(-1) ?? ''],
        }));
        expect((await operations.diagnoseWifi()).sections.wirelessRates.status).toBe('unavailable');
    });
    it('collects current WAN status, health and bounded site ISP histories without mutations', async () => {
        const { operations, request } = setup();
        const result = await operations.diagnoseWan({ gatewayMac: MAC });
        expect(result.collectionComplete).toBe(true);
        expect(Object.keys(result.sections)).toEqual(['status', 'ispHistory', 'health']);
        expect(request.request).toHaveBeenCalledTimes(3);
        expect(request.request.mock.calls.every(([config]) => config.method === 'GET')).toBe(true);
        expect(result.sections.ispHistory).toMatchObject({ data: [{ portId: 1, samples: { data: [{ time: TIME, totalRate: 32, latency: 5 }] } }] });
        expect(result.notes.join(' ')).toContain('site-wide');
    });
    it.each([
        undefined,
        null,
        {},
        { apTrafficActivities: [] },
        { apTrafficActivities: [{ time: TIME, txData: 1 }], switchTrafficActivities: [] },
        { apTrafficActivities: [{ time: NOW, txData: 1, rxData: 1 }], switchTrafficActivities: [] },
    ])('marks malformed or missing traffic evidence unavailable: %j', async (value) => {
        const { request, operations } = setup();
        request.request.mockResolvedValue({ errorCode: 0, result: value });
        const result = await operations.getTrafficHistory();
        expect(result.sections.traffic.status).toBe('unavailable');
        expect(result.collectionComplete).toBe(false);
    });
    it.each([
        { start: -1 },
        { start: 1.5 },
        { end: Number.NaN },
        { end: NOW / 1000 + 1 },
        { start: NOW / 1000 },
        { start: NOW / 1000 - 86_401 },
        { start: NOW, end: NOW + 1000 },
        { maxSamples: 0 },
        { maxSamples: 1001 },
        { maxSamples: 1.5 },
    ])('rejects invalid bounds before controller access: %j', async (options) => {
        const { request, operations } = setup();
        await expect(operations.getTrafficHistory(options)).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
    it('rejects identity-only and textual WAN health evidence without hiding other sections', async () => {
        const { request, operations } = setup();
        request.request.mockImplementation(async ({ url }: { url: string }) => ({
            errorCode: 0,
            result: url.endsWith('/details') ? { wanDetails: [{ port: 1, latency: 'unknown' }] } : payloads[url.split('/').at(-1) ?? ''],
        }));
        const result = await operations.diagnoseWan({ gatewayMac: MAC });
        expect(result.sections.health.status).toBe('unavailable');
        expect(result.sections.status.status).toBe('ok');
        expect(result.collectionComplete).toBe(false);
    });
    it('does not require an uplink record when an AP explicitly reports a wired connection', async () => {
        const { request, operations } = setup();
        request.request.mockImplementation(async ({ url }: { url: string }) => ({
            errorCode: 0,
            result: url.endsWith('statistics') ? { wirelessLinked: false, wirelessUplink: {} } : payloads[url.split('/').at(-1) ?? ''],
        }));
        expect((await operations.diagnoseWifi({ apMac: MAC })).sections.mesh).toMatchObject({ status: 'ok', data: { wirelessLinked: false } });
    });
    it('rejects invalid device identifiers before controller access', async () => {
        const { request, operations } = setup();
        await expect(operations.diagnoseWan({ gatewayMac: '../gateway' })).rejects.toThrow('MAC');
        await expect(operations.diagnoseWifi({ apMac: '../ap' })).rejects.toThrow('MAC');
        expect(request.request).not.toHaveBeenCalled();
    });
    it('preserves true empty histories as complete', async () => {
        const { request, operations } = setup();
        request.request.mockResolvedValue({ errorCode: 0, result: { apTrafficActivities: [], switchTrafficActivities: [] } });
        const result = await operations.getTrafficHistory();
        expect(result.collectionComplete).toBe(true);
        expect(result.sections.traffic).toMatchObject({
            data: { apTrafficActivities: { data: [], availableSamples: 0 }, switchTrafficActivities: { data: [], availableSamples: 0 } },
        });
    });
});
