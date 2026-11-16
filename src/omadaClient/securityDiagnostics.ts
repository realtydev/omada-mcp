import { z } from 'zod';

import type { OmadaApiResponse } from '../types/index.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(512);
const identifier = z.string().min(1).max(256);
const mac = z.string().regex(/^(?:[\da-f]{12}|(?:[\da-f]{2}[:-]){5}[\da-f]{2})$/i);
export const securityDiagnosticOptionsSchema = z
    .object({
        siteId: identifier.optional(),
        start: integer.optional().describe('Threat window start, epoch seconds; defaults to 24 hours before end.'),
        end: integer.optional().describe('Threat window end, epoch seconds; defaults to now. Maximum window: 24 hours.'),
        pageSize: z.number().int().min(1).max(200).default(100).describe('Maximum records from page 1 of each source; no automatic page reads.'),
    })
    .strict();
export type SecurityDiagnosticOptions = z.input<typeof securityDiagnosticOptionsSchema>;
const rogueSchema = z.object({
    id: identifier,
    bssid: mac,
    ssid: text.optional(),
    radioId: integer.optional(),
    security: integer.optional(),
    beacon: integer.optional(),
    channel: integer.optional(),
    nearestApMac: mac.optional(),
    nearestAp: text.optional(),
    mode: integer.optional(),
    signal: z.number().int().min(-127).max(0).optional(),
    lastSeen: integer.optional(),
});
const widsSchema = z
    .object({
        stationMac: mac.optional(),
        stationMacList: z.array(mac).min(1).max(64).optional(),
        detectMac: mac,
        channel: integer.optional(),
        band: integer.optional(),
        startTime: integer,
        type: integer,
        level: integer.optional(),
    })
    .refine((row) => row.stationMac !== undefined || row.stationMacList !== undefined);
const threatSchema = z.object({
    id: identifier,
    time: integer,
    srcCountry: text.optional(),
    service: text.optional(),
    severity: z.number().int().min(0).max(4),
    category: integer.optional(),
    classification: text.optional(),
});
type Row = Record<string, unknown>;
export interface SecurityPage {
    records: Row[];
    page: 1;
    pageSize: number;
    totalRows?: number;
    hasMore: boolean | 'unknown';
    truncated: boolean;
    completenessKnown: boolean;
    invalidRecords: number;
    excludedRecords: number;
    duplicateRecords: number;
}
export type SecuritySection = {
    source: string;
    collectedAt: number;
    scope: string;
    timestampUnits: Record<string, string>;
} & (
    | { status: 'ok' | 'partial'; data: SecurityPage }
    | { status: 'forbidden' | 'unsupported' | 'unavailable' | 'unknown'; reason: string; httpStatus?: number; errorCode?: number }
);
const object = (value: unknown): Row | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;

function failure(error: unknown) {
    const e = object(error),
        response = object(e?.response),
        body = object(response?.data);
    const httpStatus = e?.status ?? response?.status;
    const errorCode = e?.errorCode ?? body?.errorCode;
    const details = {
        ...(typeof httpStatus === 'number' && Number.isSafeInteger(httpStatus) ? { httpStatus } : {}),
        ...(typeof errorCode === 'number' && Number.isSafeInteger(errorCode) ? { errorCode } : {}),
    };
    if ([401, 403].includes(Number(httpStatus)) || [-44106, -44112, -44113].includes(Number(errorCode)))
        return { status: 'forbidden' as const, reason: 'Access to this security evidence was denied.', ...details };
    if ([404, 405, 501].includes(Number(httpStatus)) || errorCode === -1600)
        return { status: 'unsupported' as const, reason: 'This security evidence endpoint is not available on the controller.', ...details };
    if ((typeof httpStatus === 'number' && httpStatus >= 500) || typeof e?.code === 'string')
        return { status: 'unavailable' as const, reason: 'This security evidence could not be collected.', ...details };
    return { status: 'unknown' as const, reason: 'The controller did not provide usable security evidence.', ...details };
}

function page(
    value: unknown,
    pageSize: number,
    project: (value: unknown) => Row,
    identity: (row: Row) => string,
    siteId: string,
    window?: { start: number; end: number }
): SecurityPage {
    const result = object(value);
    if (!result || !Array.isArray(result.data) || result.data.length > pageSize) throw new TypeError('Unusable security page');
    if (result.currentPage !== undefined && result.currentPage !== 1) throw new TypeError('Unexpected security page');
    if (result.currentSize !== undefined && result.currentSize !== pageSize) throw new TypeError('Unexpected security page size');
    let invalidRecords = 0;
    let excludedRecords = 0;
    const candidates: Array<{ row: Row; key: string }> = [];
    const identities = new Map<string, number>();
    for (const item of result.data) {
        try {
            const raw = object(item);
            if (!raw) throw new TypeError('Unusable security record');
            if (raw.siteId !== undefined && raw.siteId !== siteId) {
                excludedRecords++;
                continue;
            }
            const row = project(item);
            if (window && (Number(row.time) < window.start || Number(row.time) > window.end)) {
                excludedRecords++;
                continue;
            }
            const key = identity(row);
            identities.set(key, (identities.get(key) ?? 0) + 1);
            candidates.push({ row, key });
        } catch {
            invalidRecords++;
        }
    }
    const records = candidates.filter(({ key }) => identities.get(key) === 1).map(({ row }) => row);
    const duplicateRecords = candidates.length - records.length;
    const totalKnown = Number.isSafeInteger(result.totalRows) && Number(result.totalRows) >= result.data.length;
    const completenessKnown = totalKnown && result.currentPage === 1 && result.currentSize !== undefined;
    return {
        records,
        page: 1,
        pageSize,
        ...(totalKnown ? { totalRows: Number(result.totalRows) } : {}),
        hasMore: totalKnown ? Number(result.totalRows) > result.data.length : 'unknown',
        truncated: totalKnown ? Number(result.totalRows) > result.data.length : result.data.length === pageSize,
        completenessKnown,
        invalidRecords,
        excludedRecords,
        duplicateRecords,
    };
}

/** Read saved security evidence only; never starts a scan or changes protection settings. */
export class SecurityDiagnosticsOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string, version?: string) => string
    ) {}

    private async read(
        source: string,
        scope: string,
        timestampUnits: Record<string, string>,
        params: Record<string, unknown>,
        parse: (value: unknown) => SecurityPage
    ): Promise<SecuritySection> {
        const evidence = { source, scope, timestampUnits, collectedAt: Date.now() };
        try {
            const response = await this.request.request<OmadaApiResponse<unknown>>({
                method: 'GET',
                url: this.buildPath(source, 'v1'),
                params,
                timeout: 10_000,
                maxContentLength: 2 * 1024 * 1024,
                maxRedirects: 0,
            });
            const data = parse(this.request.ensureSuccess(response));
            const complete =
                data.completenessKnown && data.hasMore === false && !data.invalidRecords && !data.excludedRecords && !data.duplicateRecords;
            return { ...evidence, collectedAt: Date.now(), status: complete ? 'ok' : 'partial', data };
        } catch (error) {
            return { ...evidence, collectedAt: Date.now(), ...failure(error) };
        }
    }

    async diagnoseSecurity(options: SecurityDiagnosticOptions = {}) {
        const input = securityDiagnosticOptionsSchema.parse(options),
            siteId = this.site.resolveSiteId(input.siteId),
            capturedAt = Date.now(),
            end = input.end ?? Math.floor(capturedAt / 1000),
            start = input.start ?? end - 86_400;
        if (start < 0 || start > end || end - start > 86_400 || end > Math.floor(capturedAt / 1000))
            throw new Error('Security threat window must be in the past and at most 24 hours.');
        const base = `/sites/${encodeURIComponent(siteId)}`;
        const params = { page: 1, pageSize: input.pageSize };
        const normalizeMac = (value: unknown) => String(value).replace(/[:-]/g, '').toLowerCase();
        const [rogueAps, wids, threats] = await Promise.all([
            this.read(`${base}/insight/rogueaps`, 'saved_scan_results', { lastSeen: 'milliseconds', signal: 'dBm' }, params, (v) =>
                page(
                    v,
                    input.pageSize,
                    (row) => rogueSchema.parse(row),
                    (row) => String(row.id),
                    siteId
                )
            ),
            this.read(`${base}/insight/wids`, 'controller_returned_detections', { startTime: 'controller_native_unspecified' }, params, (v) =>
                page(
                    v,
                    input.pageSize,
                    (row) => widsSchema.parse(row),
                    (row) =>
                        JSON.stringify([
                            normalizeMac(row.detectMac),
                            row.startTime,
                            row.type,
                            row.stationMac === undefined ? null : normalizeMac(row.stationMac),
                            Array.isArray(row.stationMacList) ? row.stationMacList.map(normalizeMac).sort() : [],
                        ]),
                    siteId
                )
            ),
            this.read(
                `${base}/ips/grid/threat-management`,
                'site_unarchived_threats_in_window',
                { time: 'seconds' },
                { ...params, archived: false, 'filters.startTime': start, 'filters.endTime': end, 'sorts.time': 'desc' },
                (v) =>
                    page(
                        v,
                        input.pageSize,
                        (row) => threatSchema.parse(row),
                        (row) => String(row.id),
                        siteId,
                        { start, end }
                    )
            ),
        ]);
        const sections = { rogueAps, wids, threats };
        const threatRows = 'data' in threats ? threats.data.records : [];
        return {
            siteId,
            capturedAt,
            completedAt: Date.now(),
            readOnly: true,
            queryWindow: { start, end, unit: 'seconds', appliesTo: ['threats'] },
            collectionComplete: Object.values(sections).every((section) => section.status === 'ok'),
            summary: {
                returnedRogueApRecords: 'data' in rogueAps ? rogueAps.data.records.length : null,
                returnedWidsRecords: 'data' in wids ? wids.data.records.length : null,
                returnedThreatRecords: 'data' in threats ? threats.data.records.length : null,
                returnedThreatsBySeverity:
                    'data' in threats
                        ? Object.fromEntries(
                              ['critical', 'major', 'moderate', 'minor', 'low'].map((label, severity) => [
                                  label,
                                  threatRows.filter((row) => row.severity === severity).length,
                              ])
                          )
                        : null,
            },
            sections,
            limitations: [
                'These are independently collected controller records, not a live security assessment or proof of malicious activity.',
                'Only page 1 of each source is read. Returned counts and severity groups describe that bounded page, not site-wide totals.',
                'The time window applies only to unarchived threat records. Rogue AP results are saved scans; WIDS exposes no time filter and its timestamp unit is unspecified.',
                'Collection time does not establish detection freshness. Missing, disabled, unavailable or empty evidence does not establish safety.',
                'No RF scan, containment, blacklist change, threat acknowledgement or protection-setting mutation is performed.',
            ],
        };
    }
}
