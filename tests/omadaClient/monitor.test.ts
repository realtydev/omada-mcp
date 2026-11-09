import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorOperations } from '../../src/omadaClient/monitor.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const NOW = 1_800_000_000_000;
const payloads: Record<string, unknown> = {
    'wifi-summary': { connectedApNum: 3, clients: 12, channelUtilization: null, totalTraffic: 0 },
    'traffic-distribution': { aps: [{ name: 'AP', mac: 'AA', traffic: 23, trafficProportion: 100 }], switches: [] },
    'retry-dropped-rate': { retryEaps: [{ apMac: 'AA', avg: 1.5, retries: [{ time: 4, rate: 3 }] }], droppedEaps: [] },
    'switch-summary': { clients: 2, connectedSwitchNum: 1, portUtilization: 40, totalTraffic: 0 },
    'poe-usage': [{ mac: 'BB', portNum: 8, totalPowerUsed: 14, totalPercentUsed: 17.5, totalPower: 80, poePorts: [{ portId: 1 }] }],
};

describe('MonitorOperations dashboard', () => {
    const request = {
        get: vi.fn(),
        ensureSuccess: vi.fn((response) => {
            if (response.errorCode !== 0) throw new Error(response.msg);
            return response.result ?? {};
        }),
    };
    const site = { resolveSiteId: vi.fn((id?: string) => id ?? 'default-site') };
    let ops: MonitorOperations;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        vi.clearAllMocks();
        request.get.mockImplementation(async (path: string) => ({ errorCode: 0, result: payloads[path.split('/').at(-1) ?? ''] }));
        ops = new MonitorOperations(
            request as unknown as RequestHandler,
            site as unknown as SiteOperations,
            (path) => `/openapi/v1/controller${path}`
        );
    });
    afterEach(() => vi.useRealTimers());

    it('reads exactly five endpoints with required second-based windows and encoded site IDs', async () => {
        const result = await ops.getSiteDashboard({ siteId: 'site/one', start: NOW / 1000 - 7200, end: NOW / 1000 - 60 });
        for (const endpoint of ['wifi-summary', 'traffic-distribution', 'retry-dropped-rate', 'switch-summary']) {
            expect(request.get).toHaveBeenCalledWith(`/openapi/v1/controller/sites/site%2Fone/dashboard/${endpoint}`, {
                start: NOW / 1000 - 7200,
                end: NOW / 1000 - 60,
            });
        }
        expect(request.get).toHaveBeenCalledWith('/openapi/v1/controller/sites/site%2Fone/dashboard/poe-usage', undefined);
        expect(request.get).toHaveBeenCalledTimes(5);
        expect(result).toMatchObject({
            capturedAt: NOW,
            completedAt: NOW,
            queryWindow: { start: NOW / 1000 - 7200, end: NOW / 1000 - 60, unit: 'seconds' },
            collectionComplete: true,
        });
    });

    it('defaults to the last hour and preserves null, zero and real empty lists without time-series or per-port expansion', async () => {
        const result = await ops.getSiteDashboard();
        expect(result.queryWindow).toEqual({ start: NOW / 1000 - 3600, end: NOW / 1000, unit: 'seconds' });
        expect(site.resolveSiteId).toHaveBeenCalledWith(undefined);
        expect(result.sections.wifi).toEqual({ status: 'ok', data: payloads['wifi-summary'], truncated: false });
        expect(result.sections.wirelessRates).toEqual({
            status: 'ok',
            data: { retryEaps: [{ apMac: 'AA', avg: 1.5 }], droppedEaps: [] },
            truncated: false,
        });
        expect(result.sections.poe).toEqual({
            status: 'ok',
            data: [{ mac: 'BB', portNum: 8, totalPowerUsed: 14, totalPercentUsed: 17.5, totalPower: 80 }],
            truncated: false,
        });
        expect(JSON.stringify(result)).not.toContain('retries');
        expect(JSON.stringify(result)).not.toContain('poePorts');
    });

    it('reports independent request and controller errors while keeping successful sections', async () => {
        request.get.mockImplementation((path: string) => {
            if (path.endsWith('wifi-summary')) throw new Error('Unsupported request path');
            if (path.endsWith('poe-usage')) return { errorCode: -100, msg: 'Permission denied' };
            return { errorCode: 0, result: payloads[path.split('/').at(-1) ?? ''] };
        });
        const result = await ops.getSiteDashboard();
        expect(result.collectionComplete).toBe(false);
        expect(result.sections.wifi).toEqual({ status: 'error', message: 'Unsupported request path' });
        expect(result.sections.poe).toEqual({ status: 'error', message: 'Permission denied' });
        expect(result.sections.switches.status).toBe('ok');
        expect(request.get).toHaveBeenCalledTimes(5);
    });

    it.each([undefined, null, {}, [], { clients: { invalid: true } }, { clients: Number.NaN }])(
        'marks a missing or malformed summary unavailable: %j',
        async (result) => {
            request.get.mockResolvedValue({ errorCode: 0, result });
            const dashboard = await ops.getSiteDashboard();
            expect(dashboard.sections.wifi.status).toBe('unavailable');
            expect(dashboard.collectionComplete).toBe(false);
        }
    );

    it('does not invent absent groups or omit malformed devices', async () => {
        request.get.mockImplementation(async (path: string) => ({
            errorCode: 0,
            result: path.endsWith('traffic-distribution')
                ? { aps: [] }
                : path.endsWith('retry-dropped-rate')
                  ? { retryEaps: [{}], droppedEaps: [] }
                  : payloads[path.split('/').at(-1) ?? ''],
        }));
        const result = await ops.getSiteDashboard();
        expect(result.sections.traffic).toMatchObject({ status: 'unavailable', message: expect.stringContaining('switches') });
        expect(result.sections.wirelessRates.status).toBe('unavailable');
        expect(result.collectionComplete).toBe(false);
    });

    it.each([
        ['wifi-summary', 'wifi', { clients: 12 }, 'connectedApNum'],
        ['switch-summary', 'switches', { clients: 2 }, 'portUtilization'],
        ['traffic-distribution', 'traffic', { aps: [{ name: 'AP' }], switches: [] }, 'traffic'],
        ['traffic-distribution', 'traffic', { aps: [{ traffic: 12 }], switches: [] }, 'trafficProportion'],
        ['retry-dropped-rate', 'wirelessRates', { retryEaps: [{ name: 'AP' }], droppedEaps: [] }, 'avg'],
        ['retry-dropped-rate', 'wirelessRates', { retryEaps: [], droppedEaps: [{ apMac: 'AA' }] }, 'avg'],
        ['poe-usage', 'poe', [{ name: 'Switch' }], 'portNum'],
        ['poe-usage', 'poe', [{ portNum: 8, totalPowerUsed: 14, totalPower: 80 }], 'totalPercentUsed'],
    ] as const)(
        'requires actual metrics for %s instead of counting identity or partial evidence as complete',
        async (endpoint, section, response, missing) => {
            request.get.mockImplementation(async (path: string) => ({
                errorCode: 0,
                result: path.endsWith(endpoint) ? response : payloads[path.split('/').at(-1) ?? ''],
            }));
            const result = await ops.getSiteDashboard();
            expect(result.sections[section]).toEqual({ status: 'unavailable', message: `Controller omitted dashboard metric: ${missing}.` });
            expect(result.collectionComplete).toBe(false);
            const successful = Object.values(result.sections).filter((value) => value.status === 'ok');
            expect(successful).toHaveLength(4);
        }
    );

    it('rejects textual metrics even when every field is present', async () => {
        request.get.mockImplementation(async (path: string) => ({
            errorCode: 0,
            result: path.endsWith('wifi-summary')
                ? { connectedApNum: '3', clients: 12, channelUtilization: null, totalTraffic: 0 }
                : payloads[path.split('/').at(-1) ?? ''],
        }));
        const result = await ops.getSiteDashboard();
        expect(result.sections.wifi).toEqual({ status: 'unavailable', message: 'Controller returned an invalid dashboard metric: connectedApNum.' });
        expect(result.collectionComplete).toBe(false);
    });

    it('bounds device lists and explicitly marks the collection incomplete', async () => {
        request.get.mockImplementation(async (path: string) => ({
            errorCode: 0,
            result: path.endsWith('poe-usage')
                ? Array.from({ length: 51 }, (_, index) => ({
                      mac: `device-${index}`,
                      portNum: 8,
                      totalPowerUsed: index,
                      totalPercentUsed: 0,
                      totalPower: 80,
                  }))
                : payloads[path.split('/').at(-1) ?? ''],
        }));
        const result = await ops.getSiteDashboard();
        expect(result.collectionComplete).toBe(false);
        expect(result.sections.poe).toMatchObject({ status: 'ok', truncated: true });
        if (result.sections.poe.status === 'ok') expect(result.sections.poe.data).toHaveLength(50);
    });

    it('preserves powered switch metrics alongside an explicitly unsupported switch without inventing power readings', async () => {
        const unsupported = { mac: 'CC', name: 'Non-PoE switch', portNum: 2, poePorts: [{ poeSupported: false }, { poeSupported: false }] };
        request.get.mockImplementation(async (path: string) => ({
            errorCode: 0,
            result: path.endsWith('poe-usage') ? [...(payloads['poe-usage'] as unknown[]), unsupported] : payloads[path.split('/').at(-1) ?? ''],
        }));
        const result = await ops.getSiteDashboard();
        expect(result.collectionComplete).toBe(true);
        expect(result.sections.poe).toEqual({
            status: 'ok',
            truncated: false,
            data: [
                { mac: 'BB', portNum: 8, totalPowerUsed: 14, totalPercentUsed: 17.5, totalPower: 80 },
                { mac: 'CC', name: 'Non-PoE switch', portNum: 2, supported: false },
            ],
        });
    });

    it.each([
        undefined,
        [],
        [{ poeSupported: false }, {}],
        [{ poeSupported: false }, { poeSupported: true }],
        [{ poeSupported: false }, { poeSupported: null }],
        [{ poeSupported: false }, null],
        [{ poeSupported: false }, { poeSupported: 'false' }],
        [Object.create({ poeSupported: false })],
    ])('requires explicit nonempty unsupported-port evidence before omitting power metrics: %j', async (poePorts) => {
        request.get.mockImplementation(async (path: string) => ({
            errorCode: 0,
            result: path.endsWith('poe-usage') ? [{ mac: 'CC', portNum: 2, poePorts }] : payloads[path.split('/').at(-1) ?? ''],
        }));
        const result = await ops.getSiteDashboard();
        expect(result.collectionComplete).toBe(false);
        expect(result.sections.poe).toEqual({ status: 'unavailable', message: 'Controller omitted dashboard metric: totalPowerUsed.' });
    });

    it.each([
        { start: -1 },
        { start: 1.5 },
        { end: Number.NaN },
        { end: NOW / 1000 + 1 },
        { start: NOW / 1000, end: NOW / 1000 },
        { start: NOW / 1000, end: NOW / 1000 - 1 },
        { start: NOW / 1000 - 86_401 },
        { start: NOW, end: NOW + 1000 },
    ])('rejects invalid, reversed, future, millisecond or oversized windows before requests: %j', async (options) => {
        await expect(ops.getSiteDashboard(options)).rejects.toThrow('epoch seconds');
        expect(request.get).not.toHaveBeenCalled();
    });

    it('accepts the 24-hour boundary and an early-epoch default start', async () => {
        await expect(ops.getSiteDashboard({ start: NOW / 1000 - 86_400 })).resolves.toMatchObject({ collectionComplete: true });
        const result = await ops.getSiteDashboard({ end: 60 });
        expect(result.queryWindow.start).toBe(0);
    });

    it('propagates missing site configuration before requests', async () => {
        site.resolveSiteId.mockImplementationOnce(() => {
            throw new Error('Missing site ID');
        });
        await expect(ops.getSiteDashboard()).rejects.toThrow('Missing site ID');
        expect(request.get).not.toHaveBeenCalled();
    });
});
