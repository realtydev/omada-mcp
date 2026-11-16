import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { SecurityDiagnosticsOperations } from '../../src/omadaClient/securityDiagnostics.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const now = 1_800_000_000;
const rogue = { id: 'scan-1', bssid: '00-11-22-33-44-55', ssid: 'neighbor', lastSeen: now * 1000, signal: -75, radioId: 1, security: 3 };
const detection = { stationMac: '00-11-22-33-44-55', detectMac: 'AA-BB-CC-DD-EE-FF', startTime: now, type: 2, level: 0, band: 1 };
const threat = { id: 'threat-1', time: now - 10, severity: 0, classification: 'controller classification', service: 'controller description' };
const grid = (data: unknown[] = []) => ({ data, totalRows: data.length, currentPage: 1, currentSize: 100 });

describe('bounded read-only wireless security diagnosis', () => {
    let responses: Record<string, unknown>;
    let request: { request: ReturnType<typeof vi.fn>; ensureSuccess: ReturnType<typeof vi.fn> };
    let ops: SecurityDiagnosticsOperations;
    beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
        responses = {
            'insight/rogueaps': grid([rogue]),
            'insight/wids': grid([detection]),
            'ips/grid/threat-management': grid([threat]),
        };
        request = {
            request: vi.fn(async (config) => ({ errorCode: 0, result: structuredClone(responses[config.url.split('/sites/site/')[1]]) })),
            ensureSuccess: vi.fn((response) => {
                if (response.errorCode !== 0) throw Object.assign(new Error('private controller detail'), { errorCode: response.errorCode });
                return response.result;
            }),
        };
        ops = new SecurityDiagnosticsOperations(
            request as unknown as RequestHandler,
            { resolveSiteId: (id?: string) => id ?? 'site' } as SiteOperations,
            (path, version) => `/openapi/${version}/controller${path}`
        );
    });

    it('reads exactly three site-scoped GET pages and preserves documented timestamp units', async () => {
        const result = await ops.diagnoseSecurity();
        expect(result).toMatchObject({
            readOnly: true,
            collectionComplete: true,
            queryWindow: { start: now - 86_400, end: now, unit: 'seconds', appliesTo: ['threats'] },
            summary: {
                returnedRogueApRecords: 1,
                returnedWidsRecords: 1,
                returnedThreatRecords: 1,
                returnedThreatsBySeverity: { critical: 1, low: 0 },
            },
            sections: {
                rogueAps: {
                    status: 'ok',
                    scope: 'saved_scan_results',
                    timestampUnits: { lastSeen: 'milliseconds', signal: 'dBm' },
                    data: { records: [rogue] },
                },
                wids: { status: 'ok', timestampUnits: { startTime: 'controller_native_unspecified' }, data: { records: [detection] } },
                threats: { status: 'ok', timestampUnits: { time: 'seconds' }, data: { records: [threat] } },
            },
        });
        expect(request.request).toHaveBeenCalledTimes(3);
        for (const [config] of request.request.mock.calls) {
            expect(config).toMatchObject({ method: 'GET', timeout: 10_000, maxContentLength: 2 * 1024 * 1024, maxRedirects: 0 });
            expect(config.url).toContain('/sites/site/');
            expect(config.url).not.toContain('/scan');
            expect(config.params).toMatchObject({ page: 1, pageSize: 100 });
        }
        expect(request.request.mock.calls[2][0]).toMatchObject({
            params: { archived: false, 'filters.startTime': now - 86_400, 'filters.endTime': now, 'sorts.time': 'desc' },
        });
    });
    it('preserves an empty result as collected evidence without asserting safety', async () => {
        for (const key of Object.keys(responses)) responses[key] = grid();
        const result = await ops.diagnoseSecurity();
        expect(result.collectionComplete).toBe(true);
        expect(result.summary.returnedThreatRecords).toBe(0);
        expect(result.limitations.join(' ')).toContain('does not establish safety');
        expect(result).not.toHaveProperty('healthy');
        expect(result).not.toHaveProperty('securityScore');
    });
    it('projects known fields and removes unknown secret-bearing data', async () => {
        responses['insight/rogueaps'] = grid([{ ...rogue, password: 'never-return', nested: { token: 'never-return' } }]);
        responses['insight/wids'] = grid([{ ...detection, stationMacList: ['AA-BB-CC-DD-EE-FF'], token: 'never-return' }]);
        responses['ips/grid/threat-management'] = grid([{ ...threat, secret: 'never-return' }]);
        const result = await ops.diagnoseSecurity();
        expect(result.summary.returnedWidsRecords).toBe(1);
        expect(JSON.stringify(result)).not.toContain('never-return');
    });
    it('supports list-form WIDS station identities and preserves native unknown event codes', async () => {
        responses['insight/wids'] = grid([{ ...detection, stationMac: undefined, stationMacList: ['11-22-33-44-55-66'], type: 77, level: 99 }]);
        expect((await ops.diagnoseSecurity()).sections.wids).toMatchObject({ status: 'ok', data: { records: [{ type: 77, level: 99 }] } });
    });
    it('returns bounded partial pages with truthful continuation and no automatic reads', async () => {
        responses['insight/rogueaps'] = { ...grid([rogue]), totalRows: 250 };
        const result = await ops.diagnoseSecurity();
        expect(result.collectionComplete).toBe(false);
        expect(result.sections.rogueAps).toMatchObject({ status: 'partial', data: { totalRows: 250, truncated: true, hasMore: true } });
        expect(request.request).toHaveBeenCalledTimes(3);
    });
    it('keeps unknown pagination completeness explicit even for an empty page', async () => {
        responses['insight/wids'] = { data: [] };
        expect((await ops.diagnoseSecurity()).sections.wids).toMatchObject({
            status: 'partial',
            data: { completenessKnown: false, hasMore: 'unknown' },
        });
    });
    it('does not treat a count inconsistent with returned rows as complete', async () => {
        responses['insight/wids'] = { ...grid([detection]), totalRows: 0 };
        expect((await ops.diagnoseSecurity()).sections.wids).toMatchObject({
            status: 'partial',
            data: { completenessKnown: false, hasMore: 'unknown' },
        });
    });
    it.each([
        ['insight/wids', { ...detection, stationMac: 'invalid' }],
        ['insight/wids', { ...detection, detectMac: undefined }],
        ['insight/wids', { ...detection, startTime: -1 }],
        ['insight/wids', { ...detection, stationMacList: Array(65).fill(detection.stationMac) }],
        ['insight/rogueaps', { ...rogue, id: undefined }],
        ['insight/rogueaps', { ...rogue, signal: 40 }],
        ['insight/rogueaps', { ...rogue, lastSeen: Number.MAX_SAFE_INTEGER + 1 }],
        ['ips/grid/threat-management', { ...threat, severity: 9 }],
        ['ips/grid/threat-management', { ...threat, time: 'not-a-time' }],
    ])('excludes malformed rows from %s without erasing other evidence', async (key, row) => {
        responses[key] = grid([row]);
        const result = await ops.diagnoseSecurity();
        const section =
            key === 'insight/wids' ? result.sections.wids : key === 'insight/rogueaps' ? result.sections.rogueAps : result.sections.threats;
        expect(section).toMatchObject({ status: 'partial', data: { records: [], invalidRecords: 1 } });
        expect(result.collectionComplete).toBe(false);
    });
    it.each([
        null,
        {},
        { data: 'not-an-array' },
        { ...grid(), currentPage: 2 },
        { ...grid([detection]), currentSize: 0 },
        { ...grid(), currentSize: 201 },
        { ...grid(), currentSize: 10 },
        grid(Array(101).fill(detection)),
    ])('reports malformed or oversized pages as unknown: %j', async (value) => {
        responses['insight/wids'] = value;
        const result = await ops.diagnoseSecurity();
        expect(result.sections.wids.status).toBe('unknown');
        expect(result.sections.rogueAps.status).toBe('ok');
        expect(result.summary.returnedWidsRecords).toBe(null);
    });
    it('excludes duplicate opaque IDs and does not choose one conflicting reading', async () => {
        responses['insight/rogueaps'] = grid([rogue, { ...rogue, signal: -40 }]);
        responses['ips/grid/threat-management'] = grid([threat, { ...threat, severity: 4 }]);
        const result = await ops.diagnoseSecurity();
        expect(result.sections.rogueAps).toMatchObject({ status: 'partial', data: { records: [], duplicateRecords: 2 } });
        expect(result.sections.threats).toMatchObject({ status: 'partial', data: { records: [], duplicateRecords: 2 } });
    });
    it('recognizes duplicate WIDS identities despite MAC spelling or station-list order', async () => {
        const stations = ['11-22-33-44-55-66', '22-33-44-55-66-77'];
        responses['insight/wids'] = grid([
            { ...detection, stationMacList: stations },
            { ...detection, stationMac: '001122334455', detectMac: 'aa:bb:cc:dd:ee:ff', stationMacList: stations.toReversed(), level: 1 },
        ]);
        expect((await ops.diagnoseSecurity()).sections.wids).toMatchObject({ status: 'partial', data: { records: [], duplicateRecords: 2 } });
    });
    it('excludes foreign-site and out-of-window records before returning their fields', async () => {
        responses['insight/rogueaps'] = grid([{ ...rogue, siteId: 'foreign', ssid: 'private-other-site' }]);
        responses['ips/grid/threat-management'] = grid([
            { ...threat, siteId: 'foreign', classification: 'private-other-site' },
            { ...threat, id: 'old', time: now - 86_401 },
            { ...threat, id: 'future', time: now + 1 },
            threat,
        ]);
        const result = await ops.diagnoseSecurity();
        expect(result.sections.rogueAps).toMatchObject({ status: 'partial', data: { records: [], excludedRecords: 1 } });
        expect(result.sections.threats).toMatchObject({ status: 'partial', data: { records: [threat], excludedRecords: 3 } });
        expect(JSON.stringify(result)).not.toContain('private-other-site');
    });
    it.each([
        [Object.assign(new Error('private detail'), { status: 403 }), 'forbidden'],
        [Object.assign(new Error('private detail'), { response: { status: 404 } }), 'unsupported'],
        [Object.assign(new Error('private detail'), { status: 503 }), 'unavailable'],
        [Object.assign(new Error('private detail'), { code: 'ETIMEDOUT' }), 'unavailable'],
        [Object.assign(new Error('private detail'), { errorCode: -44113 }), 'forbidden'],
        [Object.assign(new Error('private detail'), { errorCode: -1600 }), 'unsupported'],
        [Object.assign(new Error('private detail'), { errorCode: -1005 }), 'unknown'],
    ])('isolates safe classified failures without losing other sources: %j', async (error, expected) => {
        const read = request.request.getMockImplementation()!;
        request.request.mockImplementation((config) => (config.url.endsWith('/wids') ? Promise.reject(error) : read(config)));
        const result = await ops.diagnoseSecurity();
        expect(result.sections.wids.status).toBe(expected);
        expect(result.sections.rogueAps.status).toBe('ok');
        expect(result.sections.threats.status).toBe('ok');
        expect(JSON.stringify(result)).not.toContain('private detail');
        expect(result.collectionComplete).toBe(false);
    });
    it('handles the live OC200 WIDS rejection as explicit evidence rather than an empty success', async () => {
        const read = request.request.getMockImplementation()!;
        request.request.mockImplementation((config) =>
            config.url.endsWith('/wids') ? Promise.resolve({ errorCode: -1005, msg: 'private controller detail' }) : read(config)
        );
        const result = await ops.diagnoseSecurity();
        expect(result.sections.wids).toMatchObject({ status: 'unknown', errorCode: -1005 });
        expect(result.summary.returnedWidsRecords).toBe(null);
        expect(JSON.stringify(result)).not.toContain('private controller detail');
    });
    it('encodes explicit site identifiers and never falls back to a global endpoint', async () => {
        await ops.diagnoseSecurity({ siteId: 'site/other' });
        for (const [config] of request.request.mock.calls) expect(config.url).toContain('/sites/site%2Fother/');
    });
    it.each([
        { pageSize: 0 },
        { pageSize: 201 },
        { pageSize: 1.5 },
        { siteId: '' },
        { start: -1 },
        { start: now + 1 },
        { start: now - 86_401 },
        { end: now + 1 },
        { end: 10 },
        { scan: true },
        { archived: true },
        { start: Number.MAX_SAFE_INTEGER + 1 },
    ])('rejects invalid or mutating input before HTTP: %j', async (options) => {
        await expect(ops.diagnoseSecurity(options)).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
});
