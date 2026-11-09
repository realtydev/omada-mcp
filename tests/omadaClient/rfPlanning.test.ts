import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { RfPlanningOperations } from '../../src/omadaClient/rfPlanning.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const attempt = { planningHistroyId: 'run-1', time: 1234, isScanSuccess: false, msg: 'No connected APs.' };
describe('read-only RF planning evidence', () => {
    let values: Record<string, unknown>;
    let request: { get: ReturnType<typeof vi.fn>; ensureSuccess: ReturnType<typeof vi.fn> };
    let ops: RfPlanningOperations;
    beforeEach(() => {
        values = {
            rfPlanning: {
                channelDeployEnable: true,
                powerAdjustEnable: true,
                scheduleEnable: false,
                occurrence: { timingType: 1, hour: 0, minute: 0 },
                excludeAps: [],
                mode: 0,
                resource: 0,
            },
            'rfPlanning/result': { status: 1 },
            'rfplanning/history': { firstDeploy: true },
            planningHistory: { totalRows: 1, currentPage: 1, currentSize: 20, data: [structuredClone(attempt)] },
            'planningHistory/run-1': {
                time: 1234,
                successDevices: 0,
                failDevices: 1,
                data: [{ name: 'AP', optimizeSuccess: false, radio2g: { origChan: '1', rcmdChan: '6', errCode: -34815 } }],
            },
        };
        request = {
            get: vi.fn(async (path: string) => ({ errorCode: 0, result: structuredClone(values[path.split('/sites/site/')[1]]) })),
            ensureSuccess: vi.fn((r) => {
                if (r.errorCode !== 0) throw Object.assign(new Error('Controller error'), { errorCode: r.errorCode });
                return r.result;
            }),
        };
        ops = new RfPlanningOperations(
            request as unknown as RequestHandler,
            { resolveSiteId: (id?: string) => id ?? 'site' } as SiteOperations,
            (path, version) => `/openapi/${version}/controller${path}`
        );
    });
    it('reads four documented endpoints and does not confuse failed attempts with successful deployment', async () => {
        const result = await ops.getRfPlanningStatus();
        expect(result).toMatchObject({
            readOnly: true,
            collectionComplete: true,
            sections: {
                current: { status: 'ok', data: { status: 1, state: 'no_result' } },
                deployment: { status: 'ok', data: { firstDeploy: true, hasSuccessfulDeployment: false } },
                history: { status: 'ok', data: { records: [attempt], page: 1, pageSize: 20, hasMore: false, completenessKnown: true } },
                detail: { status: 'not_requested' },
            },
        });
        expect(request.get).toHaveBeenCalledTimes(4);
        expect(request.get).toHaveBeenCalledWith('/openapi/v1/controller/sites/site/rfPlanning', undefined);
        expect(request.get).toHaveBeenCalledWith('/openapi/v1/controller/sites/site/planningHistory', { page: 1, pageSize: 20 });
        expect(result.completedAt).toBeGreaterThanOrEqual(result.capturedAt);
    });
    it.each([
        [0, 'completed'],
        [1, 'no_result'],
        [2, 'planning'],
        [3, 'canceling'],
        [99, 'unknown'],
    ] as const)('preserves native status %s', async (code, state) => {
        values['rfPlanning/result'] = { status: code, beforeIndex: 20, afterIndex: 30, failType: 1 };
        expect((await ops.getRfPlanningStatus()).sections.current).toMatchObject({
            status: 'ok',
            data: { status: code, state, beforeIndex: 20, afterIndex: 30, failType: 1 },
        });
    });
    it('reads bounded per-device detail only when requested and strips unknown secret-bearing fields', async () => {
        Object.assign(values.rfPlanning as object, { password: 'never-return', unknown: 'never-return' });
        Object.assign(values['planningHistory/run-1'] as object, { secret: 'never-return' });
        const result = await ops.getRfPlanningStatus({ planningHistoryId: 'run-1' });
        expect(request.get).toHaveBeenCalledTimes(5);
        expect(result.sections.detail).toMatchObject({
            status: 'ok',
            data: { successDevices: 0, failDevices: 1, data: [{ optimizeSuccess: false, radio2g: { errCode: -34815 } }] },
        });
        expect(JSON.stringify(result)).not.toContain('never-return');
    });
    it('encodes explicit site and history IDs', async () => {
        await ops.getRfPlanningStatus({ siteId: 'site/other', planningHistoryId: 'run/other' });
        expect(request.get).toHaveBeenCalledWith('/openapi/v1/controller/sites/site%2Fother/planningHistory/run%2Fother', undefined);
    });
    it('returns one requested page with truthful continuation evidence and no automatic page reads', async () => {
        values.planningHistory = { currentPage: 2, currentSize: 1, totalRows: 4, data: [attempt] };
        const r = await ops.getRfPlanningStatus({ historyPage: 2, historyPageSize: 1 });
        expect(r.sections.history).toMatchObject({
            status: 'ok',
            data: { scope: 'requested_page', page: 2, pageSize: 1, totalRows: 4, hasMore: true },
        });
        expect(request.get).toHaveBeenCalledTimes(4);
    });
    it('does not claim completeness or no more history when metadata is absent', async () => {
        values.planningHistory = { data: [] };
        expect((await ops.getRfPlanningStatus()).sections.history).toMatchObject({
            status: 'ok',
            data: { records: [], hasMore: 'unknown', completenessKnown: false },
        });
    });
    it('reports a confirmed empty history without fabricating deployment success', async () => {
        values.planningHistory = { data: [], totalRows: 0, currentPage: 1, currentSize: 20 };
        expect((await ops.getRfPlanningStatus()).sections.history).toMatchObject({
            status: 'ok',
            data: { records: [], totalRows: 0, hasMore: false },
        });
    });
    it.each([
        [Object.assign(new Error('private controller detail'), { status: 403 }), 'forbidden'],
        [Object.assign(new Error('private controller detail'), { status: 404 }), 'unsupported'],
        [Object.assign(new Error('private controller detail'), { status: 503 }), 'unavailable'],
        [Object.assign(new Error('private controller detail'), { code: 'ETIMEDOUT' }), 'unavailable'],
        [Object.assign(new Error('private controller detail'), { errorCode: -44113 }), 'forbidden'],
        [Object.assign(new Error('private controller detail'), { errorCode: -1600 }), 'unsupported'],
        [new Error('private controller detail'), 'unknown'],
    ])('keeps other sections on failure %j', async (error, status) => {
        const read = request.get.getMockImplementation()!;
        request.get.mockImplementation((path: string) => (path.endsWith('/rfPlanning/result') ? Promise.reject(error) : read(path)));
        const r = await ops.getRfPlanningStatus();
        expect(r.collectionComplete).toBe(false);
        expect(r.sections.current.status).toBe(status);
        expect(r.sections.configuration.status).toBe('ok');
        expect(r.sections.history.status).toBe('ok');
        expect(JSON.stringify(r)).not.toContain('private controller detail');
    });
    it('classifies a controller-level rejection rather than an empty success', async () => {
        request.get.mockResolvedValue({ errorCode: -44106, msg: 'private controller detail' });
        const r = await ops.getRfPlanningStatus();
        expect(r.sections.history).toMatchObject({ status: 'forbidden', errorCode: -44106 });
        expect(r.collectionComplete).toBe(false);
        expect(JSON.stringify(r)).not.toContain('private controller detail');
    });
    it.each([
        ['configuration', 'rfPlanning', {}],
        ['current', 'rfPlanning/result', {}],
        ['deployment', 'rfplanning/history', {}],
        ['history', 'planningHistory', {}],
        ['history', 'planningHistory', { data: [{}] }],
        ['history', 'planningHistory', { data: [], totalRows: 5, currentPage: 1, currentSize: 20 }],
        ['history', 'planningHistory', { data: [attempt, attempt], totalRows: 2, currentPage: 1, currentSize: 20 }],
        ['history', 'planningHistory', { data: [attempt], totalRows: 0, currentPage: 1, currentSize: 20 }],
        ['history', 'planningHistory', { data: [], totalRows: 0, currentPage: 2, currentSize: 20 }],
        ['history', 'planningHistory', { data: [], totalRows: 0, currentPage: 1, currentSize: 100 }],
        ['detail', 'planningHistory/run-1', { data: Array.from({ length: 257 }, () => ({ name: 'AP' })) }],
    ])('does not treat invalid %s evidence as absence', async (section, key, value) => {
        values[key] = value;
        const r = await ops.getRfPlanningStatus({ planningHistoryId: 'run-1' });
        expect(r.sections[section as keyof typeof r.sections].status).toBe('unknown');
        expect(r.collectionComplete).toBe(false);
    });
    it('rejects a controller response exceeding the requested history bound', async () => {
        values.planningHistory = { data: [attempt, { ...attempt, planningHistroyId: 'run-2' }], totalRows: 2 };
        expect((await ops.getRfPlanningStatus({ historyPageSize: 1 })).sections.history.status).toBe('unknown');
    });
    it.each([
        { historyPage: 0 },
        { historyPageSize: 101 },
        { historyPage: 1.5 },
        { planningHistoryId: '' },
        { planningHistoryId: 'x'.repeat(257) },
        { extra: true },
    ])('rejects invalid options before reads: %j', async (options) => {
        await expect(ops.getRfPlanningStatus(options)).rejects.toThrow();
        expect(request.get).not.toHaveBeenCalled();
    });
});
