import { z } from 'zod';

import type { OmadaApiResponse } from '../types/index.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.union([
    integer,
    z
        .string()
        .min(1)
        .max(128)
        .regex(/^[\w.-]+$/),
]);
const text = z.string().min(1).max(512);
const mac = z.string().regex(/^(?:[\da-f]{12}|(?:[\da-f]{2}[:-]){5}[\da-f]{2})$/i);
export const clientApplicationTrafficOptionsSchema = z
    .object({
        clientMac: mac.describe('One client MAC address; no site-wide client collection.'),
        siteId: z.string().min(1).max(256).optional(),
        start: integer.optional().describe('Window start, epoch seconds; defaults to one hour before end.'),
        end: integer.optional().describe('Window end, epoch seconds; defaults to now. Maximum window: 24 hours.'),
        maxApplications: z.number().int().min(1).max(500).default(100).describe('Maximum returned application rows; truncation is explicit.'),
    })
    .strict();
export type ClientApplicationTrafficOptions = z.input<typeof clientApplicationTrafficOptionsSchema>;
type Row = Record<string, unknown>;
export interface ApplicationMetadata {
    applicationId: number | string;
    applicationName: string;
    nameSource: 'application' | 'applicationName';
    description?: string;
    family?: string;
}
export interface ApplicationMetadataPage {
    records: ApplicationMetadata[];
    totalRows?: number;
    truncated: boolean;
    completenessKnown: boolean;
    invalidRecords: number;
    duplicateRecords: number;
}
export interface ClientApplicationRecord {
    applicationId: number | string;
    applicationName?: string;
    metrics: Record<string, number>;
    reportedTimes?: Record<string, number>;
    missingFields: string[];
    metadata: { status: 'matched'; value: ApplicationMetadata } | { status: 'unresolved' | 'not_found' | 'ambiguous' };
}
export interface ClientApplicationData {
    applications: ClientApplicationRecord[];
    availableRecords: number;
    truncated: boolean;
    invalidRecords: number;
    duplicateRecords: number;
}
export type ApplicationEvidence<T> = { source: string; collectedAt: number } & (
    | { status: 'ok' | 'partial'; data: T }
    | { status: 'forbidden' | 'unsupported' | 'unavailable' | 'unknown'; reason: string; httpStatus?: number; errorCode?: number }
);
const object = (value: unknown): Row | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;
const metadataSchema = z
    .object({
        applicationId: id,
        applicationName: text.optional(),
        application: text.optional(),
        description: text.optional(),
        family: text.optional(),
    })
    .refine((row) => row.applicationName !== undefined || row.application !== undefined)
    .refine((row) => row.applicationName === undefined || row.application === undefined || row.applicationName === row.application)
    .transform((row) => ({
        applicationId: row.applicationId,
        applicationName: (row.applicationName ?? row.application)!,
        nameSource: row.applicationName !== undefined ? ('applicationName' as const) : ('application' as const),
        ...(row.description !== undefined ? { description: row.description } : {}),
        ...(row.family !== undefined ? { family: row.family } : {}),
    }));
const metricNames = ['upload', 'download', 'traffic', 'up', 'down', 'upPacket', 'downPacket', 'trafficPercent'] as const;
const key = (value: number | string) => `${typeof value}:${value}`;
const METADATA_LIMIT = 1000;

function failure(error: unknown) {
    const e = object(error),
        response = object(e?.response),
        body = object(response?.data);
    const httpStatus = e?.status ?? response?.status,
        errorCode = e?.errorCode ?? body?.errorCode;
    const details = {
        ...(typeof httpStatus === 'number' && Number.isSafeInteger(httpStatus) ? { httpStatus } : {}),
        ...(typeof errorCode === 'number' && Number.isSafeInteger(errorCode) ? { errorCode } : {}),
    };
    if ([401, 403].includes(Number(httpStatus)) || [-44106, -44112, -44113].includes(Number(errorCode)))
        return { status: 'forbidden' as const, reason: 'Access to application evidence was denied.', ...details };
    if ([404, 405, 501].includes(Number(httpStatus)) || errorCode === -1600 || errorCode === -35113)
        return { status: 'unsupported' as const, reason: 'This application evidence is not supported by the controller or gateway.', ...details };
    if (errorCode === -35112) return { status: 'unavailable' as const, reason: 'The controller reports no gateway for this evidence.', ...details };
    if (errorCode === -35107)
        return { status: 'unavailable' as const, reason: 'The controller reports that DPI protocols are updating.', ...details };
    if ((typeof httpStatus === 'number' && httpStatus >= 500) || typeof e?.code === 'string')
        return { status: 'unavailable' as const, reason: 'Application evidence could not be collected.', ...details };
    return { status: 'unknown' as const, reason: 'The controller did not provide usable application evidence.', ...details };
}

/** Selected-client reads only; controller-native counters are never converted into guessed rates or totals. */
export class ClientApplicationTrafficOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}

    private async read<T>(
        source: string,
        params: Row | undefined,
        project: (value: unknown) => T,
        complete: (value: T) => boolean
    ): Promise<ApplicationEvidence<T>> {
        try {
            const response = await this.request.request<OmadaApiResponse<unknown>>({
                method: 'GET',
                url: this.buildPath(source),
                ...(params ? { params } : {}),
                timeout: 10_000,
                maxContentLength: 2 * 1024 * 1024,
                maxRedirects: 0,
            });
            const data = project(this.request.ensureSuccess(response));
            return { source, collectedAt: Date.now(), status: complete(data) ? 'ok' : 'partial', data };
        } catch (error) {
            return { source, collectedAt: Date.now(), ...failure(error) };
        }
    }

    async getClientApplicationTraffic(options: ClientApplicationTrafficOptions) {
        const input = clientApplicationTrafficOptionsSchema.parse(options),
            capturedAt = Date.now();
        const end = input.end ?? Math.floor(capturedAt / 1000),
            start = input.start ?? end - 3600;
        if (start < 0 || start > end || end - start > 86_400 || end > Math.floor(capturedAt / 1000))
            throw new Error('Application traffic requires a past window of at most 24 hours in epoch seconds.');
        const siteId = this.site.resolveSiteId(input.siteId);
        const clientMac = input.clientMac.replace(/[:-]/g, '').toUpperCase().match(/.{2}/g)!.join('-');
        const base = `/sites/${encodeURIComponent(siteId)}`;
        const [dpi, metadata, traffic] = await Promise.all([
            this.read(
                `${base}/applicationControl/status`,
                undefined,
                (value) => {
                    const r = object(value);
                    if (!r) throw new TypeError('Unusable DPI settings');
                    return {
                        ...(typeof r.dpi === 'boolean' ? { dpi: r.dpi } : {}),
                        ...(typeof r.loggingTraffic === 'boolean' ? { loggingTraffic: r.loggingTraffic } : {}),
                    };
                },
                (value) => value.dpi !== undefined && value.loggingTraffic !== undefined
            ),
            this.read(
                `${base}/applicationControl/applications`,
                { page: 1, pageSize: METADATA_LIMIT },
                (value): ApplicationMetadataPage => {
                    const r = object(value);
                    if (!r || !Array.isArray(r.data) || (r.currentPage !== undefined && r.currentPage !== 1))
                        throw new TypeError('Unusable application metadata');
                    if (r.currentSize !== undefined && r.currentSize !== METADATA_LIMIT) throw new TypeError('Unexpected metadata page size');
                    const candidates: ApplicationMetadata[] = [];
                    let invalidRecords = 0;
                    const ids = new Map<string, number>();
                    for (const raw of r.data.slice(0, METADATA_LIMIT)) {
                        const row = object(raw);
                        if (row?.siteId !== undefined && row.siteId !== siteId) {
                            invalidRecords++;
                            continue;
                        }
                        const parsed = metadataSchema.safeParse(raw);
                        if (!parsed.success) {
                            invalidRecords++;
                            continue;
                        }
                        candidates.push(parsed.data);
                        const identity = key(parsed.data.applicationId);
                        ids.set(identity, (ids.get(identity) ?? 0) + 1);
                    }
                    const records = candidates.filter((row) => ids.get(key(row.applicationId)) === 1);
                    const countKnown = typeof r.totalRows === 'number' && Number.isSafeInteger(r.totalRows) && r.totalRows >= r.data.length;
                    return {
                        records,
                        ...(countKnown ? { totalRows: r.totalRows as number } : {}),
                        truncated:
                            r.data.length > METADATA_LIMIT || (countKnown ? Number(r.totalRows) > r.data.length : r.data.length >= METADATA_LIMIT),
                        completenessKnown: countKnown && r.currentPage === 1 && r.currentSize === METADATA_LIMIT,
                        invalidRecords,
                        duplicateRecords: candidates.length - records.length,
                    };
                },
                (value) => value.completenessKnown && !value.truncated && !value.invalidRecords && !value.duplicateRecords
            ),
            this.read(
                `${base}/dashboard/specificClientInfo/${encodeURIComponent(clientMac)}`,
                { start, end },
                (value): ClientApplicationData => {
                    if (!Array.isArray(value)) throw new TypeError('Unusable selected-client application traffic');
                    const applications: ClientApplicationRecord[] = [];
                    let invalidRecords = 0;
                    const ids = new Map<string, number>();
                    for (const raw of value.slice(0, input.maxApplications)) {
                        const row = object(raw),
                            parsedId = id.safeParse(row?.applicationId);
                        if (
                            !row ||
                            !parsedId.success ||
                            (row.siteId !== undefined && row.siteId !== siteId) ||
                            (row.clientMac !== undefined && !mac.safeParse(row.clientMac).success)
                        ) {
                            invalidRecords++;
                            continue;
                        }
                        if (
                            ['clientMac', 'mac'].some(
                                (field) =>
                                    row[field] !== undefined &&
                                    (!mac.safeParse(row[field]).success ||
                                        String(row[field]).replace(/[:-]/g, '').toUpperCase() !== clientMac.replaceAll('-', ''))
                            )
                        ) {
                            invalidRecords++;
                            continue;
                        }
                        const metrics: Record<string, number> = {},
                            missingFields: string[] = [];
                        for (const name of metricNames) {
                            if (row[name] === undefined) continue;
                            const n = row[name];
                            if (
                                typeof n === 'number' &&
                                Number.isFinite(n) &&
                                n >= 0 &&
                                n <= Number.MAX_SAFE_INTEGER &&
                                (name !== 'trafficPercent' || n <= 100)
                            )
                                metrics[name] = n;
                            else missingFields.push(name);
                        }
                        const reportedTimes: Record<string, number> = {};
                        for (const field of ['time', 'timestamp', 'start', 'end']) {
                            if (row[field] === undefined) continue;
                            if (integer.safeParse(row[field]).success) reportedTimes[field] = row[field] as number;
                            else missingFields.push(field);
                        }
                        if (!Object.keys(metrics).length) missingFields.push('traffic_metrics');
                        const name = text.safeParse(row.applicationName);
                        if (row.applicationName !== undefined && !name.success) missingFields.push('applicationName');
                        applications.push({
                            applicationId: parsedId.data,
                            ...(name.success ? { applicationName: name.data } : {}),
                            metrics,
                            ...(Object.keys(reportedTimes).length ? { reportedTimes } : {}),
                            missingFields,
                            metadata: { status: 'unresolved' },
                        });
                        const identity = key(parsedId.data);
                        ids.set(identity, (ids.get(identity) ?? 0) + 1);
                    }
                    let duplicateRecords = 0;
                    for (const row of applications)
                        if (ids.get(key(row.applicationId))! > 1) {
                            row.metadata = { status: 'ambiguous' };
                            duplicateRecords++;
                        }
                    return {
                        applications,
                        availableRecords: value.length,
                        truncated: value.length > input.maxApplications,
                        invalidRecords,
                        duplicateRecords,
                    };
                },
                (value) =>
                    !value.truncated &&
                    !value.invalidRecords &&
                    !value.duplicateRecords &&
                    value.applications.length > 0 &&
                    value.applications.every((row) => !row.missingFields.length)
            ),
        ]);
        if ('data' in traffic && !traffic.data.truncated && metadata.status === 'ok' && 'data' in metadata) {
            const map = new Map(metadata.data.records.map((row) => [key(row.applicationId), row]));
            for (const row of traffic.data.applications)
                if (row.metadata.status !== 'ambiguous') {
                    const found = map.get(key(row.applicationId));
                    row.metadata = found ? { status: 'matched', value: found } : { status: 'not_found' };
                }
        }
        const metadataSummary =
            'data' in metadata
                ? (() => {
                      const { records, ...coverage } = metadata.data;
                      return { ...metadata, data: { ...coverage, returnedRecords: records.length } };
                  })()
                : metadata;
        return {
            readOnly: true as const,
            siteId,
            clientMac,
            capturedAt,
            completedAt: Date.now(),
            queryWindow: { start, end, unit: 'seconds' as const, appliesTo: ['traffic'] },
            collectionComplete: dpi.status === 'ok' && metadata.status === 'ok' && traffic.status === 'ok',
            recording:
                'data' in dpi && (dpi.data.dpi === false || dpi.data.loggingTraffic === false)
                    ? ('disabled' as const)
                    : 'data' in dpi && dpi.data.dpi === true && dpi.data.loggingTraffic === true
                      ? ('enabled' as const)
                      : ('unknown' as const),
            reportedTimeUnits: 'controller_native_unspecified' as const,
            metricUnits: Object.fromEntries(
                metricNames.map((name) => [name, name === 'trafficPercent' ? 'controller_reported_percent' : 'controller_native_unspecified'])
            ),
            sections: { dpi, metadata: metadataSummary, traffic },
            limitations: [
                'Traffic counters retain their reported names and values. Their byte units, aggregation/reset semantics and measurement timestamps are not established; no rates or combined totals are inferred.',
                'The requested time window applies to selected-client traffic only. Retrieval time does not establish measurement freshness.',
                'Application metadata reads one page of at most 1,000 rows. Incomplete, malformed or duplicate metadata suppresses joins; traffic retains its own reported names.',
                'Empty traffic is incomplete evidence, not proof of zero usage. Disabled or unknown DPI/logging settings do not establish that historical records are absent.',
                'No client fanout, DPI enablement, traffic-policy change or speed test is performed.',
            ],
        };
    }
}
