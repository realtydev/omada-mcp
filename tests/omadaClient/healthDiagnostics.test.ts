import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LldpEvidence } from '../../src/omadaClient/healthDiagnostics.js';
import { correlateLldp, HealthDiagnosticsOperations } from '../../src/omadaClient/healthDiagnostics.js';
import type { SwitchPortOverview } from '../../src/omadaClient/switchPortRead.js';
import type { OmadaDeviceInfo } from '../../src/types/index.js';

const NOW = 1_800_000_000_000,
    SW = 'AA-BB-CC-DD-EE-01',
    AP = 'AA-BB-CC-DD-EE-02';
const grid = (data: unknown[] = [], totalRows = data.length) => ({ data, totalRows, currentPage: 1, currentSize: 100 });
const neighbor = () => ({
    portId: 2,
    standardPortIndex: { unit: 1, slot: 0, port: 2 },
    deviceId: AP,
    neighborPortId: 'eth0',
    ttl: 120,
    password: 'secret',
});
function setup() {
    const request = { request: vi.fn(), ensureSuccess: vi.fn((r) => r.result) };
    const site = { resolveSiteId: (s?: string) => s ?? 'site' };
    const ops = new HealthDiagnosticsOperations(request as never, site as never, (p) => `/openapi/v1/controller${p}`);
    return { request, ops };
}
const score = () => ({
    time: NOW - 1000,
    siteHealthScore: 0,
    deviceHealthScore: 99,
    clientHealthScore: 80,
    wifiHealthScore: 75,
    wanHealthScore: 100,
    secret: 'secret',
});
const inventory = [
    { mac: SW, type: 'switch' },
    { mac: AP, type: 'ap' },
] as OmadaDeviceInfo[];
function overview(): SwitchPortOverview {
    return {
        inventoryStatus: 'ok',
        inventoryTruncated: false,
        switches: [{ switchMac: SW, inventoryKnown: true }],
        ports: [{ switchMac: SW, port: 2, standardPort: { unit: 1, slot: 0, port: 2 } }],
    } as SwitchPortOverview;
}
function evidence(records = [{ ...neighbor(), neighborMac: AP }]): LldpEvidence {
    return {
        status: 'ok',
        switchMac: SW,
        source: 'getGridLldpNeighborTable',
        collectedAt: NOW,
        data: { records, totalRows: records.length, truncated: false, completenessKnown: true, invalidRecords: 0 },
    };
}
describe('bounded native health and LLDP evidence', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());
    it('preserves native score zero and historical incident status with exact millisecond GET contracts', async () => {
        const { ops, request } = setup();
        request.request.mockResolvedValueOnce({ result: { scores: [score()] } }).mockResolvedValueOnce({
            result: grid([
                {
                    anomalyCode: '01001001',
                    category: 12,
                    level: 2,
                    status: 1,
                    lastTime: NOW - 10,
                    firstTime: NOW - 100,
                    count: 2,
                    titleParams: { password: 'secret' },
                    password: 'secret',
                },
            ]),
        });
        const r = await ops.getSiteHealth('a/b', NOW - 3600_000, NOW);
        expect(r.collectionComplete).toBe(true);
        expect(r.sections.timeline.data?.scores[0].siteHealthScore).toBe(0);
        expect(r.sections.incidents.data?.records[0]).toMatchObject({ status: 1, count: 2 });
        expect(JSON.stringify(r)).not.toContain('secret');
        expect(request.request.mock.calls.map(([v]) => v.method)).toEqual(['GET', 'GET']);
        expect(request.request.mock.calls[0][0]).toMatchObject({
            url: '/openapi/v1/controller/sites/a%2Fb/health/timeline',
            params: { start: NOW - 3600_000, end: NOW },
            maxContentLength: 1024 * 1024,
            maxRedirects: 0,
        });
        expect(request.request.mock.calls[1][0].params).toEqual({
            page: 1,
            pageSize: 100,
            'filters.startTime': NOW - 3600_000,
            'filters.endTime': NOW,
        });
    });
    it('derives an end-only default start from that exact end without clock drift', async () => {
        const { ops, request } = setup();
        request.request.mockResolvedValueOnce({ result: { scores: [score()] } }).mockResolvedValueOnce({ result: grid() });
        const r = await ops.getSiteHealth('site', undefined, NOW - 100);
        expect(r.queryWindow).toEqual({ start: NOW - 100 - 86_400_000, end: NOW - 100, unit: 'milliseconds' });
    });
    it('keeps successful scores when incidents fail without returning raw errors', async () => {
        const { ops, request } = setup();
        request.request
            .mockResolvedValueOnce({ result: { scores: [score()] } })
            .mockRejectedValueOnce(Object.assign(new Error('private token=secret'), { status: 403 }));
        const r = await ops.getSiteHealth();
        expect(r.sections.timeline.status).toBe('ok');
        expect(r.sections.incidents.status).toBe('forbidden');
        expect(r.collectionComplete).toBe(false);
        expect(JSON.stringify(r)).not.toContain('secret');
    });
    it.each([401, 403, 404, 405, 500])('classifies rejected LLDP evidence (%s) without leaking response bodies', async (status) => {
        const { ops, request } = setup();
        request.request.mockRejectedValue({ response: { status, data: { msg: 'secret' } } });
        const r = await ops.getSwitchLldpNeighbors(SW);
        expect(r.status).toBe(status < 404 ? 'forbidden' : status < 500 ? 'unsupported' : 'unavailable');
        expect(JSON.stringify(r)).not.toContain('secret');
    });
    it('marks negative, missing, duplicate and out-of-window score evidence partial', async () => {
        const { ops, request } = setup();
        request.request
            .mockResolvedValueOnce({ result: { scores: [{ ...score(), wanHealthScore: -1 }, score(), { ...score(), time: NOW + 1 }] } })
            .mockResolvedValueOnce({ result: grid() });
        const r = await ops.getSiteHealth();
        expect(r.sections.timeline).toMatchObject({ status: 'partial', data: { invalidRecords: 2, missingScores: 1 } });
        expect(r.sections.timeline.data?.scores[0]).not.toHaveProperty('wanHealthScore');
    });
    it('retains live OC200 negative-score sentinels as missing and refuses an earlier rounded bucket', async () => {
        const { ops, request } = setup();
        const unknownScores = { siteHealthScore: -1, deviceHealthScore: -1, clientHealthScore: -1, wifiHealthScore: -1, wanHealthScore: -1 };
        request.request
            .mockResolvedValueOnce({
                result: {
                    scores: [
                        { time: NOW - 3600_001, ...unknownScores },
                        { time: NOW - 1800_000, ...unknownScores },
                    ],
                },
            })
            .mockResolvedValueOnce({ result: grid() });
        const r = await ops.getSiteHealth('site', NOW - 3600_000, NOW);
        expect(r.sections.timeline).toMatchObject({
            status: 'partial',
            data: { invalidRecords: 1, missingScores: 5, scores: [{ time: NOW - 1800_000 }] },
        });
        expect(r.sections.incidents.status).toBe('ok');
        expect(r.collectionComplete).toBe(false);
    });
    it('treats an empty health timeline as missing evidence', async () => {
        const { ops, request } = setup();
        request.request.mockResolvedValueOnce({ result: { scores: [] } }).mockResolvedValueOnce({ result: grid() });
        expect((await ops.getSiteHealth()).collectionComplete).toBe(false);
    });
    it.each([{ currentPage: 2 }, { currentPage: undefined }, { currentSize: 99 }, { currentSize: undefined }, { totalRows: -1 }])(
        'refuses complete grid evidence with invalid metadata %j',
        async (metadata) => {
            const { ops, request } = setup();
            request.request.mockResolvedValue({ result: { ...grid([neighbor()]), ...metadata } });
            const r = await ops.getSwitchLldpNeighbors(SW);
            expect(r.status).not.toBe('ok');
            expect(correlateLldp(r, overview(), inventory)).toEqual([]);
        }
    );
    it('accepts a valid short page whose currentSize remains the requested page size', async () => {
        const { ops, request } = setup();
        request.request.mockResolvedValue({ result: grid([neighbor()]) });
        const r = await ops.getSwitchLldpNeighbors(SW);
        expect(r.status).toBe('ok');
        expect(r.data?.records[0].standardPortIndex).toEqual({ unit: 1, slot: 0, port: 2 });
        expect(JSON.stringify(r)).not.toContain('secret');
        expect(correlateLldp(r, overview(), inventory)).toEqual([
            {
                switchMac: SW,
                neighborMac: AP,
                port: 2,
                standardPort: { unit: 1, slot: 0, port: 2 },
                neighborPortId: 'eth0',
                basis: 'lldp_advertisement',
            },
        ]);
    });
    it('excludes all duplicates and refuses associations on truncated source evidence', async () => {
        const { ops, request } = setup();
        request.request.mockResolvedValueOnce({ result: grid([neighbor(), neighbor()]) }).mockResolvedValueOnce({ result: grid([neighbor()], 101) });
        const duplicate = await ops.getSwitchLldpNeighbors(SW);
        expect(duplicate.status).toBe('partial');
        expect(duplicate.data?.records).toEqual([]);
        const truncated = await ops.getSwitchLldpNeighbors(SW);
        expect(truncated.data?.truncated).toBe(true);
        expect(correlateLldp(truncated, overview(), inventory)).toEqual([]);
    });
    it('keeps malformed identities unknown rather than treating advertised names as MACs', async () => {
        const { ops, request } = setup();
        request.request.mockResolvedValue({ result: grid([{ ...neighbor(), deviceId: 'Office AP', systemName: AP }]) });
        const r = await ops.getSwitchLldpNeighbors(SW);
        expect(r.data?.records[0].neighborMac).toBeUndefined();
        expect(correlateLldp(r, overview(), inventory)).toEqual([]);
    });
    it.each([
        { ttl: 0 },
        { ttl: undefined },
        { deviceId: SW, neighborMac: SW },
        { standardPortIndex: { unit: 2, slot: 0, port: 2 } },
        { standardPort: 'Tw2/0/2' },
        { standardPort: '' },
        { standardPort: { unit: 1, slot: 0, port: 2 } },
        { standardPortIndex: { unit: 1, slot: 0, port: 3 }, standardPort: 'Tw1/0/2' },
    ])('never corroborates expired, self, ambiguous or contradictory identity %j', async (patch) => {
        const { ops, request } = setup();
        request.request.mockResolvedValue({ result: grid([{ ...neighbor(), ...patch }]) });
        const r = await ops.getSwitchLldpNeighbors(SW);
        expect(correlateLldp(r, overview(), inventory)).toEqual([]);
    });
    it('requires unique managed identities, established standalone inventory and requested adjacent neighbor', () => {
        const r = evidence(),
            o = overview();
        expect(correlateLldp(r, o, [...inventory, inventory[1]])).toEqual([]);
        expect(correlateLldp(r, o, [...inventory, inventory[0]])).toEqual([]);
        expect(correlateLldp(r, o, inventory, new Set([SW]))).toEqual([]);
        expect(correlateLldp(r, { ...o, ports: [...o.ports, o.ports[0]] }, inventory)).toEqual([]);
        expect(correlateLldp(r, { ...o, inventoryTruncated: true }, inventory)).toEqual([]);
        expect(correlateLldp(r, { ...o, ports: [{ ...o.ports[0], standardPort: { unit: 2, slot: 0, port: 2 } }] }, inventory)).toEqual([]);
        expect(correlateLldp(r, { ...o, switches: [{ ...o.switches[0], inventoryKnown: false }] }, inventory)).toEqual([]);
    });
    it('bounds response projections and rejects invalid inputs before network activity', async () => {
        const { ops, request } = setup();
        await expect(ops.getSiteHealth('site', NOW - 86_400_001, NOW)).rejects.toThrow('24 hours');
        await expect(ops.getSiteHealth('site', NOW, NOW + 1)).rejects.toThrow('24 hours');
        await expect(ops.getSwitchLldpNeighbors('bad')).rejects.toThrow('MAC');
        expect(request.request).not.toHaveBeenCalled();
        request.request
            .mockResolvedValueOnce({ result: { scores: Array.from({ length: 513 }, (_, i) => ({ ...score(), time: NOW - i })) } })
            .mockResolvedValueOnce({ result: grid() });
        const r = await ops.getSiteHealth();
        expect(r.sections.timeline.data?.scores).toHaveLength(512);
        expect(r.sections.timeline.data?.truncated).toBe(true);
    });
});
