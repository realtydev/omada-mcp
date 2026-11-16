import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientApplicationTrafficOperations } from '../../src/omadaClient/clientApplicationTraffic.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

const now = 1_800_000_000;
const clientMac = 'AA-BB-CC-DD-EE-01';
const app = { applicationId: 1, applicationName: 'Example', description: 'description', family: 'family' };
const traffic = { applicationId: 1, applicationName: 'Reported name', upload: 0, download: 12, traffic: 12 };
const grid = (data: unknown[] = [app]) => ({ data, currentPage: 1, currentSize: 1000, totalRows: data.length });

describe('selected-client application traffic', () => {
    let responses: Record<string, unknown>;
    let request: { request: ReturnType<typeof vi.fn>; ensureSuccess: ReturnType<typeof vi.fn> };
    let ops: ClientApplicationTrafficOperations;
    beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
        responses = { status: { dpi: true, loggingTraffic: true }, applications: grid(), [`specificClientInfo/${clientMac}`]: [traffic] };
        request = {
            request: vi.fn((config) => {
                const name = config.url
                    .split('/site/')[1]
                    .replace(/^applicationControl\//, '')
                    .replace(/^dashboard\//, '');
                const result = responses[name];
                if (result instanceof Error) throw result;
                return Promise.resolve({ errorCode: 0, result: structuredClone(result) });
            }),
            ensureSuccess: vi.fn((response) => response.result),
        };
        ops = new ClientApplicationTrafficOperations(
            request as unknown as RequestHandler,
            { resolveSiteId: (id?: string) => id ?? 'site' } as SiteOperations,
            (path) => `/openapi/v1/controller${path}`
        );
    });
    it('uses exactly three fixed GET reads and joins only matching IDs', async () => {
        const result = await ops.getClientApplicationTraffic({ clientMac: clientMac.toLowerCase().replaceAll('-', ':') });
        expect(result).toMatchObject({
            readOnly: true,
            recording: 'enabled',
            collectionComplete: true,
            clientMac,
            queryWindow: { start: now - 3600, end: now, unit: 'seconds', appliesTo: ['traffic'] },
            sections: {
                metadata: { status: 'ok', data: { returnedRecords: 1, totalRows: 1 } },
                traffic: {
                    status: 'ok',
                    data: {
                        applications: [
                            {
                                applicationId: 1,
                                applicationName: 'Reported name',
                                metrics: { upload: 0, download: 12, traffic: 12 },
                                metadata: { status: 'matched', value: { ...app, nameSource: 'applicationName' } },
                            },
                        ],
                    },
                },
            },
        });
        expect(result.sections.metadata).not.toHaveProperty('data.records');
        expect(result).not.toHaveProperty('rates');
        expect(result).not.toHaveProperty('totalBytes');
        expect(result.metricUnits.upload).toBe('controller_native_unspecified');
        expect(request.request).toHaveBeenCalledTimes(3);
        for (const [config] of request.request.mock.calls)
            expect(config).toMatchObject({ method: 'GET', timeout: 10_000, maxContentLength: 2097152, maxRedirects: 0 });
        expect(request.request.mock.calls[1][0].params).toEqual({ page: 1, pageSize: 1000 });
        expect(request.request.mock.calls[2][0].params).toEqual({ start: now - 3600, end: now });
    });
    it('supports the live application alias without discarding its provenance', async () => {
        responses.applications = grid([{ applicationId: 1, application: 'Live name' }]);
        expect((await ops.getClientApplicationTraffic({ clientMac })).sections.traffic).toMatchObject({
            data: { applications: [{ metadata: { status: 'matched', value: { applicationName: 'Live name', nameSource: 'application' } } }] },
        });
    });
    it('explains possible OC200 limitations for an empty response with recording enabled without diagnosing the controller', async () => {
        responses[`specificClientInfo/${clientMac}`] = [];
        const result = await ops.getClientApplicationTraffic({ clientMac });
        expect(result).toMatchObject({
            recording: 'enabled',
            collectionComplete: false,
            sections: { traffic: { status: 'partial', data: { applications: [], availableRecords: 0 } } },
        });
        const explanation = result.limitations.join(' ');
        expect(explanation).toContain('OC200');
        expect(explanation).toContain('User analytics UI');
        expect(explanation).toContain('possible reason');
        expect(explanation).toContain('not a detected controller model or a confirmed API limitation');
        expect(explanation).toContain('https://support.omadanetworks.com/en/document/13241/');
        expect(explanation).toContain('getApplicationControlTraffics');
        expect(explanation).toContain('aggregate counters cannot establish per-client usage');
        expect(request.request).toHaveBeenCalledTimes(3);
        expect(request.request.mock.calls.every(([config]) => config.method === 'GET')).toBe(true);
    });
    it.each([{ value: [{ ...traffic, upload: 0, download: 0, traffic: 0 }] }, { value: [{ ...traffic, siteId: 'other' }] }, { value: null }])(
        'does not label populated, rejected or malformed records as an empty controller response %j',
        async ({ value }) => {
            responses[`specificClientInfo/${clientMac}`] = value;
            const result = await ops.getClientApplicationTraffic({ clientMac });
            expect(result.limitations.join(' ')).not.toContain('OC200');
        }
    );
    it.each([403, 404, 500])('preserves source failure %i without suggesting an empty OC200 response', async (status) => {
        responses[`specificClientInfo/${clientMac}`] = Object.assign(new Error('private failure'), { status });
        const result = await ops.getClientApplicationTraffic({ clientMac });
        expect(result.sections.traffic).toHaveProperty('httpStatus', status);
        expect(result.limitations.join(' ')).not.toContain('OC200');
        expect(JSON.stringify(result)).not.toContain('private failure');
    });
    it('keeps disabled DPI and omitted logging distinct from empty or zero traffic', async () => {
        responses.status = { dpi: false };
        responses.applications = { ...grid(), totalRows: 2788 };
        responses[`specificClientInfo/${clientMac}`] = [];
        const result = await ops.getClientApplicationTraffic({ clientMac });
        expect(result).toMatchObject({
            recording: 'disabled',
            collectionComplete: false,
            sections: {
                dpi: { status: 'partial', data: { dpi: false } },
                metadata: { status: 'partial', data: { truncated: true, totalRows: 2788 } },
                traffic: { status: 'partial', data: { applications: [], availableRecords: 0 } },
            },
        });
        expect(result.sections.dpi).not.toHaveProperty('data.loggingTraffic');
    });
    it('does not turn explicitly disabled traffic logging into an absent-record assertion', async () => {
        responses.status = { dpi: true, loggingTraffic: false };
        const result = await ops.getClientApplicationTraffic({ clientMac });
        expect(result.recording).toBe('disabled');
        expect(result.sections.traffic).toMatchObject({
            status: 'ok',
            data: { applications: [expect.objectContaining({ metrics: expect.objectContaining({ download: 12 }) })] },
        });
    });
    it('projects safe fields and never returns unrelated client or configuration details', async () => {
        responses.applications = grid([{ ...app, secret: 'never-return', clients: [{ name: 'never-return' }] }]);
        responses[`specificClientInfo/${clientMac}`] = [{ ...traffic, password: 'never-return', nested: { token: 'never-return' } }];
        expect(JSON.stringify(await ops.getClientApplicationTraffic({ clientMac }))).not.toContain('never-return');
    });
    it.each([
        { clientMac: '../scan' },
        { clientMac: 'AA-BB-CC-DD-EE' },
        { clientMac, scan: true },
        { clientMac, maxApplications: 501 },
        { clientMac, maxApplications: 0 },
        { clientMac, start: -1 },
        { clientMac, end: now + 1 },
        { clientMac, start: now, end: now - 1 },
        { clientMac, start: now - 86401 },
        { clientMac, start: '100' },
        { clientMac, siteId: '' },
    ])('rejects invalid options before requests %j', async (value) => {
        await expect(ops.getClientApplicationTraffic(value as never)).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });
    it('uses a caller window without widening it', async () => {
        const result = await ops.getClientApplicationTraffic({ clientMac, start: now - 86400, end: now });
        expect(result.queryWindow).toMatchObject({ start: now - 86400, end: now });
    });
    it.each([null, {}, { data: [traffic] }, 'private login page'])('refuses unknown traffic envelopes %j', async (value) => {
        responses[`specificClientInfo/${clientMac}`] = value;
        const result = await ops.getClientApplicationTraffic({ clientMac });
        expect(result.sections.traffic.status).toBe('unknown');
        expect(result.sections.metadata.status).toBe('ok');
    });
    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '12', null])(
        'never replaces invalid counter %j with zero',
        async (value) => {
            responses[`specificClientInfo/${clientMac}`] = [{ ...traffic, upload: value }];
            const result = await ops.getClientApplicationTraffic({ clientMac });
            expect(result.sections.traffic).toMatchObject({
                status: 'partial',
                data: { applications: [{ missingFields: ['upload'], metrics: { download: 12, traffic: 12 } }] },
            });
            expect(result.sections.traffic).not.toHaveProperty('data.applications.0.metrics.upload');
        }
    );
    it('retains native reported timestamps without assuming their units or widening the window', async () => {
        responses[`specificClientInfo/${clientMac}`] = [{ ...traffic, time: now * 1000, timestamp: now, start: 'unknown' }];
        const result = await ops.getClientApplicationTraffic({ clientMac });
        expect(result.reportedTimeUnits).toBe('controller_native_unspecified');
        expect(result.sections.traffic).toMatchObject({
            status: 'partial',
            data: { applications: [{ reportedTimes: { time: now * 1000, timestamp: now }, missingFields: ['start'] }] },
        });
    });
    it('refuses conflicting client identity aliases', async () => {
        responses[`specificClientInfo/${clientMac}`] = [{ ...traffic, clientMac, mac: '00-11-22-33-44-55' }];
        expect((await ops.getClientApplicationTraffic({ clientMac })).sections.traffic).toMatchObject({
            status: 'partial',
            data: { invalidRecords: 1, applications: [] },
        });
    });
    it('retains missing metrics as missing evidence', async () => {
        responses[`specificClientInfo/${clientMac}`] = [{ applicationId: 1 }];
        expect((await ops.getClientApplicationTraffic({ clientMac })).sections.traffic).toMatchObject({
            status: 'partial',
            data: { applications: [{ missingFields: ['traffic_metrics'], metrics: {} }] },
        });
    });
    it('bounds traffic rows and suppresses joins when unseen identities could conflict', async () => {
        responses[`specificClientInfo/${clientMac}`] = [traffic, { ...traffic, applicationId: 2 }, traffic];
        const result = await ops.getClientApplicationTraffic({ clientMac, maxApplications: 1 });
        expect(result.sections.traffic).toMatchObject({
            status: 'partial',
            data: { availableRecords: 3, truncated: true, applications: [{ metadata: { status: 'unresolved' } }] },
        });
    });
    it('reports duplicate traffic IDs as ambiguous without picking a row', async () => {
        responses[`specificClientInfo/${clientMac}`] = [traffic, traffic];
        expect((await ops.getClientApplicationTraffic({ clientMac })).sections.traffic).toMatchObject({
            status: 'partial',
            data: { duplicateRecords: 2, applications: [{ metadata: { status: 'ambiguous' } }, { metadata: { status: 'ambiguous' } }] },
        });
    });
    it('does not coerce distinct string and numeric application IDs into a match', async () => {
        responses[`specificClientInfo/${clientMac}`] = [{ ...traffic, applicationId: '1' }];
        expect((await ops.getClientApplicationTraffic({ clientMac })).sections.traffic).toMatchObject({
            data: { applications: [{ metadata: { status: 'not_found' } }] },
        });
    });
    it.each([
        { ...grid([app, app]) },
        { ...grid(), totalRows: 2788 },
        { data: [app] },
        grid([{ ...app, application: 'conflicting' }]),
        grid([{ ...app, siteId: 'other' }]),
    ])('does not join incomplete, duplicate, conflicting or foreign metadata %j', async (value) => {
        responses.applications = value;
        const result = await ops.getClientApplicationTraffic({ clientMac });
        expect(result.sections.metadata.status).toBe('partial');
        expect(result.sections.traffic).toMatchObject({ data: { applications: [{ metadata: { status: 'unresolved' } }] } });
    });
    it.each([{ ...grid(), currentPage: 2 }, { ...grid(), currentSize: 10 }, { data: null }])(
        'refuses invalid metadata envelopes %j',
        async (value) => {
            responses.applications = value;
            const result = await ops.getClientApplicationTraffic({ clientMac });
            expect(result.sections.metadata.status).toBe('unknown');
            expect(result.sections.traffic.status).toBe('ok');
        }
    );
    it('excludes explicit foreign client and site records', async () => {
        responses[`specificClientInfo/${clientMac}`] = [
            { ...traffic, siteId: 'other' },
            { ...traffic, clientMac: '00-11-22-33-44-55' },
            { ...traffic, clientMac: 'invalid' },
        ];
        expect((await ops.getClientApplicationTraffic({ clientMac })).sections.traffic).toMatchObject({
            status: 'partial',
            data: { invalidRecords: 3, applications: [] },
        });
    });
    it.each([
        [401, undefined, 'forbidden'],
        [403, undefined, 'forbidden'],
        [404, undefined, 'unsupported'],
        [500, undefined, 'unavailable'],
        [undefined, -35113, 'unsupported'],
        [undefined, -35112, 'unavailable'],
        [undefined, -35107, 'unavailable'],
        [undefined, -1005, 'unknown'],
    ])('sanitizes failure %j/%j as %s', async (status, errorCode, expected) => {
        responses[`specificClientInfo/${clientMac}`] = Object.assign(new Error('never-return private body'), { status, errorCode });
        const result = await ops.getClientApplicationTraffic({ clientMac });
        expect(result.sections.traffic.status).toBe(expected);
        expect(JSON.stringify(result)).not.toContain('never-return');
        expect(result.sections.metadata.status).toBe('ok');
    });
});
