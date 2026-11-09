import { z } from 'zod';
import type { OmadaApiResponse } from '../types/index.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

export const rfPlanningOptionsSchema = z
    .object({
        siteId: z.string().min(1).optional(),
        historyPage: z.number().int().min(1).max(100_000).default(1),
        historyPageSize: z.number().int().min(1).max(100).default(20),
        planningHistoryId: z.string().min(1).max(256).optional(),
    })
    .strict();
export type GetRfPlanningOptions = z.input<typeof rfPlanningOptionsSchema>;
type FailureStatus = 'forbidden' | 'unsupported' | 'unavailable' | 'unknown';
export type RfPlanningSection<T> = { source: string; collectedAt: number } & (
    | { status: 'ok'; data: T }
    | { status: FailureStatus; reason: string; httpStatus?: number; errorCode?: number }
);
const integer = z.number().int().safe();
const count = integer.nonnegative();
const text = z.string().max(1024);
const flags = {
    channelDeployEnable: z.boolean().optional(),
    channelWidthDeployEnable: z.boolean().optional(),
    bandDeployEnable: z.boolean().optional(),
    powerAdjustEnable: z.boolean().optional(),
};
const radioSchema = z.object({
    origChan: text.optional(),
    rcmdChan: text.optional(),
    origChanWidth: text.optional(),
    rcmdChanWidth: text.optional(),
    origPower: integer.optional(),
    rcmdPower: integer.optional(),
    origBand: integer.optional(),
    rcmdBand: integer.optional(),
    errCode: integer.optional(),
});
const deviceSchema = z.object({
    name: text.optional(),
    model: text.optional(),
    modelVersion: text.optional(),
    type: text.optional(),
    ip: text.optional(),
    optimizeSuccess: z.boolean().optional(),
    support5g2: z.boolean().optional(),
    radio2g: radioSchema.optional(),
    radio5g: radioSchema.optional(),
    radio5g2: radioSchema.optional(),
    radio6g: radioSchema.optional(),
    failMsg: text.optional(),
    failMsgType: integer.optional(),
});
const detailShape = {
    ...flags,
    time: count.optional(),
    currentConfig: integer.optional(),
    successDevices: count.optional(),
    failDevices: count.optional(),
    data: z.array(deviceSchema).max(256).optional(),
};
const detailSchema = z.object(detailShape).refine((v) => Object.keys(v).length > 0, 'No recognized planning detail');
const configSchema = z
    .object({
        ...detailShape,
        scheduleEnable: z.boolean().optional(),
        occurrence: z
            .object({ timingType: integer.optional(), hour: integer.min(0).max(23).optional(), minute: integer.min(0).max(59).optional() })
            .optional(),
        excludeAps: z.array(z.string().max(256)).max(256).optional(),
        mode: integer.optional(),
        resource: integer.optional(),
    })
    .refine((v) => Object.keys(v).length > 0, 'No recognized planning configuration');
const resultSchema = z.object({
    status: integer,
    planningHistroyId: z.string().max(256).optional(),
    beforeIndex: integer.min(0).max(100).optional(),
    afterIndex: integer.min(0).max(100).optional(),
    failType: integer.nullable().optional(),
});
const historyRecordSchema = z.object({
    planningHistroyId: z.string().min(1).max(256),
    time: count,
    ...flags,
    beforeIndex: integer.min(0).max(100).optional(),
    afterIndex: integer.min(0).max(100).optional(),
    apNum: count.optional(),
    length: count.optional(),
    mode: integer.optional(),
    isScanSuccess: z.boolean().nullable().optional(),
    isAppliedSuccess: z.boolean().nullable().optional(),
    currentConfig: integer.optional(),
    msg: text.optional(),
    msgType: integer.optional(),
    failedMacs2g: text.optional(),
    failedMacs5g: text.optional(),
    failedMacs6g: text.optional(),
});
const historySchema = z.object({
    data: z.array(historyRecordSchema).max(100),
    totalRows: count.optional(),
    currentPage: integer.min(1).optional(),
    currentSize: integer.min(1).max(1000).optional(),
});
const deploymentSchema = z.object({ firstDeploy: z.boolean() });
const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function failure(error: unknown): { status: FailureStatus; reason: string; httpStatus?: number; errorCode?: number } {
    const value = record(error);
    const response = record(value?.response);
    const body = record(response?.data);
    const httpStatus = typeof value?.status === 'number' ? value.status : response?.status;
    const errorCode = value?.errorCode ?? body?.errorCode;
    const details = {
        ...(typeof httpStatus === 'number' && Number.isSafeInteger(httpStatus) ? { httpStatus } : {}),
        ...(typeof errorCode === 'number' && Number.isSafeInteger(errorCode) ? { errorCode } : {}),
    };
    if (httpStatus === 401 || httpStatus === 403 || [-44106, -44112, -44113].includes(Number(errorCode)))
        return { status: 'forbidden', reason: 'The controller denied this read.', ...details };
    if ([404, 405, 501].includes(Number(httpStatus)) || errorCode === -1600)
        return { status: 'unsupported', reason: 'The requested RF planning evidence is not available on this route.', ...details };
    if ((typeof httpStatus === 'number' && httpStatus >= 500) || typeof value?.code === 'string')
        return { status: 'unavailable', reason: 'RF planning evidence could not be collected.', ...details };
    return { status: 'unknown', reason: 'The controller did not provide usable RF planning evidence.', ...details };
}

/** A bounded, read-only view; never starts scans, applies plans or restores radio settings. */
export class RfPlanningOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string, version?: string) => string
    ) {}

    private async read<T>(source: string, parse: (value: unknown) => T, params?: Record<string, unknown>): Promise<RfPlanningSection<T>> {
        try {
            const response = await this.request.get<OmadaApiResponse<unknown>>(this.buildPath(source, 'v1'), params);
            return { source, collectedAt: Date.now(), status: 'ok', data: parse(this.request.ensureSuccess(response)) };
        } catch (error) {
            return { source, collectedAt: Date.now(), ...failure(error) };
        }
    }

    public async getRfPlanningStatus(options: GetRfPlanningOptions = {}) {
        const input = rfPlanningOptionsSchema.parse(options);
        const siteId = this.site.resolveSiteId(input.siteId);
        const base = `/sites/${encodeURIComponent(siteId)}`;
        const capturedAt = Date.now();
        const [configuration, current, deployment, history, detail] = await Promise.all([
            this.read(`${base}/rfPlanning`, (v) => configSchema.parse(v)),
            this.read(`${base}/rfPlanning/result`, (v) => {
                const data = resultSchema.parse(v);
                const states: Record<number, string> = { 0: 'completed', 1: 'no_result', 2: 'planning', 3: 'canceling' };
                return { ...data, state: states[data.status] ?? 'unknown' };
            }),
            this.read(`${base}/rfplanning/history`, (v) => {
                const data = deploymentSchema.parse(v);
                return { ...data, hasSuccessfulDeployment: !data.firstDeploy };
            }),
            this.read(
                `${base}/planningHistory`,
                (v) => {
                    const data = historySchema.parse(v);
                    const { historyPage: page, historyPageSize: pageSize } = input;
                    if (
                        data.data.length > pageSize ||
                        (data.currentPage !== undefined && data.currentPage !== page) ||
                        (data.currentSize !== undefined && data.currentSize !== pageSize)
                    )
                        throw new Error('Controller did not honor the requested history page');
                    if (new Set(data.data.map((e) => e.planningHistroyId)).size !== data.data.length)
                        throw new Error('Duplicate RF planning history IDs');
                    const offset = (page - 1) * pageSize;
                    if (
                        data.totalRows !== undefined &&
                        ((offset + data.data.length > data.totalRows && data.data.length > 0) ||
                            data.data.length < Math.min(pageSize, Math.max(data.totalRows - offset, 0)))
                    )
                        throw new Error('Inconsistent RF planning history count');
                    return {
                        scope: 'requested_page' as const,
                        page,
                        pageSize,
                        records: data.data,
                        ...(data.totalRows !== undefined ? { totalRows: data.totalRows } : {}),
                        hasMore: data.totalRows === undefined ? ('unknown' as const) : page * pageSize < data.totalRows,
                        completenessKnown: data.totalRows !== undefined && data.currentPage !== undefined && data.currentSize !== undefined,
                    };
                },
                { page: input.historyPage, pageSize: input.historyPageSize }
            ),
            input.planningHistoryId === undefined
                ? Promise.resolve({ status: 'not_requested' as const })
                : this.read(`${base}/planningHistory/${encodeURIComponent(input.planningHistoryId)}`, (v) => detailSchema.parse(v)),
        ]);
        const sections = { configuration, current, deployment, history, detail };
        return {
            siteId,
            capturedAt,
            completedAt: Date.now(),
            readOnly: true,
            collectionComplete: Object.values(sections).every((s) => s.status === 'ok' || s.status === 'not_requested'),
            sections,
            limitations: [
                'Reads are collected independently; this is not an atomic snapshot or a live RF health measurement.',
                'History covers only the requested page. firstDeploy means no successful deployment yet, not no historical attempts.',
                'Controller history timestamps and status codes are retained without inferring freshness, units or optimization quality.',
                'Only recognized bounded fields are returned. Endpoint availability does not establish permission to optimize.',
            ],
        };
    }
}
