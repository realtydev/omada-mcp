import type { OmadaApiResponse } from '../types/index.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

const MAX_DEVICES = 50;
const MAX_CHANNELS = 256;
const MAX_WINDOW_SECONDS = 86_400;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
type Row = Record<string, unknown>;
const NUMERIC_FIELDS = new Set([
    'time',
    'txData',
    'dxData',
    'wrNum',
    'rxData',
    'channel',
    'apNum',
    'clientNum',
    'channelUtilization',
    'interUtil',
    'avg',
    'status',
    'statusCategory',
    'scanStatus',
    'rssi',
    'snr',
    'linkStatus',
    'hop',
    'childsnum',
    'port',
    'portId',
    'latency',
    'loss',
    'rxRate',
    'txRate',
    'healthLevel',
    'mode',
    'type',
    'speed',
    'duplex',
    'rx',
    'tx',
    'totalRate',
    'txRateInt',
    'rxRateInt',
    'retryTimes',
    'retryRate',
    'dropTimes',
    'dropRate',
]);
const STRING_FIELDS = new Set(['mac', 'apMac', 'uplinkMac', 'name', 'portName', 'model', 'ip']);
export interface NetworkDiagnosticOptions {
    siteId?: string;
    start?: number;
    end?: number;
    maxSamples?: number;
}
export interface WifiHistoryOptions extends NetworkDiagnosticOptions {
    apMac?: string;
}
export interface WanDiagnosticOptions extends NetworkDiagnosticOptions {
    gatewayMac: string;
}
export type NetworkDiagnosticSection =
    | { status: 'ok' | 'partial'; data: unknown; truncated: boolean; missing?: string[] }
    | { status: 'unavailable' | 'error'; message: string };
export interface NetworkDiagnosticsResult {
    capturedAt: number;
    completedAt: number;
    source: 'controller-api';
    queryWindow: { start: number; end: number; unit: 'seconds' };
    maxSamples: number;
    collectionComplete: boolean;
    sections: Record<string, NetworkDiagnosticSection>;
    notes: string[];
}
interface Projection {
    data: unknown;
    truncated: boolean;
    missing?: string[];
}
interface SampleBudget {
    remaining: number;
    truncated: boolean;
}

function record(value: unknown): Row {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Controller did not return an evidence object');
    return value as Row;
}
function array(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new Error('Controller did not return an evidence list');
    return value;
}
function metric(value: unknown, key: string): number | null {
    if (value === null || (typeof value === 'number' && Number.isFinite(value))) return value;
    throw new Error(`Controller omitted or malformed metric: ${key}`);
}
function select(value: unknown, fields: readonly string[], requiredMetrics: readonly string[] = []): Row {
    const source = record(value);
    const result: Row = {};
    for (const key of requiredMetrics) {
        if (['port', 'portId', 'channel'].includes(key) && (!Number.isSafeInteger(source[key]) || (source[key] as number) < 0))
            throw new Error(`Controller omitted or malformed identifier: ${key}`);
        result[key] = metric(source[key], key);
    }
    for (const key of fields) {
        if (!Object.hasOwn(source, key)) continue;
        const field = source[key];
        if (NUMERIC_FIELDS.has(key)) metric(field, key);
        if (STRING_FIELDS.has(key) && field !== null && typeof field !== 'string') throw new Error(`Malformed evidence field: ${key}`);
        if (field !== null && !['string', 'number', 'boolean'].includes(typeof field)) throw new Error(`Malformed evidence field: ${key}`);
        if (typeof field === 'number' && !Number.isFinite(field)) throw new Error(`Malformed evidence field: ${key}`);
        result[key] = field;
    }
    return result;
}
function series(value: unknown, metrics: readonly string[], budget: SampleBudget, aliases: Record<string, string> = {}): Row {
    const input = array(value);
    const selected = input.slice(0, budget.remaining);
    budget.remaining -= selected.length;
    const truncated = selected.length < input.length;
    budget.truncated ||= truncated;
    const usedAliases: Record<string, string> = {};
    const data = selected.map((item) => {
        const row = record(item);
        if (!Number.isSafeInteger(row.time) || (row.time as number) < 0 || (row.time as number) >= 1_000_000_000_000) {
            throw new Error('Controller returned a sample without an epoch-second timestamp');
        }
        const sourceMetrics = metrics.map((key) => {
            if (!Object.hasOwn(row, key) && Object.hasOwn(aliases, key) && Object.hasOwn(row, aliases[key])) {
                usedAliases[key] = aliases[key];
                return aliases[key];
            }
            return key;
        });
        return select(row, ['time', ...sourceMetrics, ...Object.values(aliases)], sourceMetrics);
    });
    return {
        data,
        availableSamples: input.length,
        returnedSamples: data.length,
        truncated,
        ...(Object.keys(usedAliases).length ? { sourceAliases: usedAliases } : {}),
    };
}
function groups(value: unknown, names: readonly string[], project: (value: unknown, group: string) => unknown): Projection {
    const source = record(value);
    const data: Row = {};
    const missing: string[] = [];
    let truncated = false;
    for (const name of names) {
        if (!Object.hasOwn(source, name) || source[name] === null) {
            missing.push(name);
            continue;
        }
        const input = array(source[name]);
        truncated ||= input.length > MAX_DEVICES;
        data[name] = input.slice(0, MAX_DEVICES).map((item) => project(item, name));
    }
    if (Object.keys(data).length === 0) throw new Error('Controller returned no recognized evidence groups');
    return { data, truncated, ...(missing.length ? { missing } : {}) };
}
function channelEvidence(value: unknown): Projection {
    const source = record(value);
    const data: Row = {};
    const missing: string[] = [];
    let truncated = false;
    for (const [legacy, current] of [
        ['2g channel stat', 'channels2g'],
        ['5g channel stat', 'channels5g'],
        ['6g channel stat', 'channels6g'],
    ]) {
        const key = Object.hasOwn(source, current) ? current : legacy;
        if (!Object.hasOwn(source, key) || source[key] === null) {
            missing.push(legacy);
            continue;
        }
        const rows = array(source[key]);
        truncated ||= rows.length > MAX_CHANNELS;
        let metricsMissing = false;
        data[key] = rows.slice(0, MAX_CHANNELS).map((value) => {
            const row = record(value);
            const projected = select(row, ['channel', 'apNum', 'wrNum', 'clientNum', 'channelUtilization'], ['channel']);
            const missingMetrics = ['apNum', 'clientNum', 'channelUtilization'].filter((name) => row[name] === undefined || row[name] === null);
            metricsMissing ||= missingMetrics.length > 0;
            return { ...projected, metricsAvailable: missingMetrics.length === 0, ...(missingMetrics.length ? { missingMetrics } : {}) };
        });
        if (metricsMissing) missing.push(`${key}:metrics`);
    }
    if (Object.keys(data).length === 0) throw new Error('Controller returned no recognized channel groups');
    return { data, truncated, ...(missing.length ? { missing } : {}) };
}

function identity(value: unknown, fields: readonly string[]): Row {
    const source = record(value);
    const output = select(source, fields);
    if (!['mac', 'apMac', 'uplinkMac', 'name'].some((key) => typeof source[key] === 'string' && source[key].length > 0))
        throw new Error('Controller omitted device identity');
    return output;
}
function validateMac(value: string, field: string): void {
    if (!/^(?:[\da-f]{12}|(?:[\da-f]{2}[:-]){5}[\da-f]{2})$/i.test(value)) throw new Error(`${field} must be a full MAC address`);
}

/** Read-only workflows for historical and current network evidence; never scans or reconfigures hardware. */
export class NetworkDiagnosticsOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}

    private window(options: NetworkDiagnosticOptions): { capturedAt: number; start: number; end: number; maxSamples: number; base: string } {
        const capturedAt = Date.now();
        const now = Math.floor(capturedAt / 1000);
        const end = options.end ?? now;
        const start = options.start ?? Math.max(0, end - 3600);
        const maxSamples = options.maxSamples ?? 144;
        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start >= end ||
            end > now ||
            end - start > MAX_WINDOW_SECONDS
        ) {
            throw new Error('Diagnostic start/end must be epoch seconds with 0 <= start < end <= now and a window no longer than 24 hours');
        }
        if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 1000) throw new Error('maxSamples must be an integer from 1 to 1000');
        const site = this.site.resolveSiteId(options.siteId);
        return { capturedAt, start, end, maxSamples, base: `/sites/${encodeURIComponent(site)}` };
    }

    private async read(path: string, params: Row | undefined, project: (data: unknown) => Projection): Promise<NetworkDiagnosticSection> {
        let value: unknown;
        try {
            const response = await this.request.request<OmadaApiResponse<unknown>>({
                method: 'GET',
                url: this.buildPath(path),
                ...(params ? { params } : {}),
                maxContentLength: MAX_RESPONSE_BYTES,
            });
            value = this.request.ensureSuccess(response);
            if (value === undefined || value === null) return { status: 'unavailable', message: 'Controller returned no evidence' };
        } catch (error) {
            return { status: 'error', message: error instanceof Error ? error.message : 'Controller evidence request failed' };
        }
        try {
            const result = project(value);
            return { status: result.missing?.length ? 'partial' : 'ok', ...result };
        } catch (error) {
            return { status: 'unavailable', message: error instanceof Error ? error.message : 'Controller evidence is malformed' };
        }
    }

    private result(
        context: ReturnType<NetworkDiagnosticsOperations['window']>,
        sections: Record<string, NetworkDiagnosticSection>,
        notes: string[]
    ): NetworkDiagnosticsResult {
        return {
            capturedAt: context.capturedAt,
            completedAt: Date.now(),
            source: 'controller-api',
            queryWindow: { start: context.start, end: context.end, unit: 'seconds' },
            maxSamples: context.maxSamples,
            collectionComplete: Object.values(sections).every((section) => section.status === 'ok' && !section.truncated),
            sections,
            notes,
        };
    }

    public async getTrafficHistory(options: NetworkDiagnosticOptions = {}): Promise<NetworkDiagnosticsResult> {
        const context = this.window(options);
        const traffic = await this.read(`${context.base}/dashboard/traffic-activities`, { start: context.start, end: context.end }, (value) => {
            const source = record(value);
            const budget: SampleBudget = { remaining: context.maxSamples, truncated: false };
            const data: Row = {};
            for (const key of ['apTrafficActivities', 'switchTrafficActivities'])
                data[key] = series(source[key], ['txData', 'rxData'], budget, { rxData: 'dxData' });
            return { data, truncated: budget.truncated };
        });
        return this.result(context, { traffic }, [
            'Traffic sample txData and downlink rxData/dxData values are reported in MB; controller field names are preserved and sourceAliases identifies known spelling differences. Accumulation and reset semantics are not inferred.',
            'maxSamples bounds the combined AP and switch series in controller response order; timestamps are preserved and no totals are extrapolated from clipped or missing samples.',
        ]);
    }

    public async getWifiHistory(options: WifiHistoryOptions = {}): Promise<NetworkDiagnosticsResult> {
        if (options.apMac !== undefined) validateMac(options.apMac, 'apMac');
        const context = this.window(options);
        const timed = { start: context.start, end: context.end };
        const reads: Array<Promise<NetworkDiagnosticSection>> = [
            this.read(`${context.base}/dashboard/channels`, undefined, channelEvidence),
            this.read(`${context.base}/dashboard/top-interference`, undefined, (value) =>
                groups(value, ['apInterference2g', 'apInterference5g', 'apInterference5g2', 'apInterference6g'], (row) => ({
                    ...identity(row, ['mac', 'name']),
                    ...select(row, ['interUtil', 'model'], ['interUtil']),
                }))
            ),
            this.read(`${context.base}/dashboard/retry-dropped-rate`, timed, (value) => {
                const budget: SampleBudget = { remaining: context.maxSamples, truncated: false };
                const result = groups(value, ['retryEaps', 'droppedEaps'], (value, group) => {
                    const row = record(value);
                    const retry = group === 'retryEaps';
                    const key = retry ? 'retries' : 'dropouts';
                    return {
                        ...identity(row, ['apMac', 'name']),
                        ...select(row, ['avg', 'status'], ['avg']),
                        [key]: series(row[key], retry ? ['retryTimes', 'retryRate'] : ['dropTimes', 'dropRate'], budget),
                    };
                });
                return { ...result, truncated: result.truncated || budget.truncated };
            }),
        ];
        if (options.apMac)
            reads.push(
                this.read(`${context.base}/aps/${encodeURIComponent(options.apMac)}/mesh/statistics`, undefined, (value) => {
                    const source = record(value);
                    if (typeof source.wirelessLinked !== 'boolean') throw new Error('Controller omitted mesh link evidence');
                    const data = select(source, ['status', 'statusCategory', 'wirelessLinked', 'scanStatus']);
                    let truncated = false;
                    for (const key of ['childAps', 'candidateParents']) {
                        if (!Object.hasOwn(source, key)) continue;
                        const rows = array(source[key]);
                        truncated ||= rows.length > MAX_DEVICES;
                        data[key] = rows
                            .slice(0, MAX_DEVICES)
                            .map((row) => identity(row, ['mac', 'name', 'rssi', 'model', 'linkStatus', 'hop', 'childsnum']));
                    }
                    if (source.wirelessLinked)
                        data.wirelessUplink = identity(source.wirelessUplink, [
                            'uplinkMac',
                            'name',
                            'rssi',
                            'snr',
                            'channel',
                            'txRateInt',
                            'rxRateInt',
                        ]);
                    return { data, truncated };
                })
            );
        const [channels, interference, wirelessRates, mesh] = await Promise.all(reads);
        return this.result(context, { channels, interference, wirelessRates, ...(mesh ? { mesh } : {}) }, [
            'Channels and interference are the latest controller snapshots, with unknown sampling freshness; only retry/drop histories use the requested time window.',
            'Omitted bands are reported as missing evidence, not empty or healthy bands. Rate units remain controller-reported; no health thresholds are invented.',
            ...(options.apMac
                ? []
                : ['Supply apMac for per-device mesh evidence. Radio configuration is intentionally not changed or duplicated here.']),
            'No RF scan, channel change, speed test or client reconnect is started.',
        ]);
    }

    public async diagnoseWan(options: WanDiagnosticOptions): Promise<NetworkDiagnosticsResult> {
        validateMac(options.gatewayMac, 'gatewayMac');
        const context = this.window(options);
        const gateway = encodeURIComponent(options.gatewayMac);
        const [status, ispHistory, health] = await Promise.all([
            this.read(`${context.base}/gateways/${gateway}/wan-status`, undefined, (value) => {
                const input = array(value);
                return {
                    data: input
                        .slice(0, MAX_DEVICES)
                        .map((row) =>
                            select(
                                row,
                                [
                                    'port',
                                    'name',
                                    'type',
                                    'mode',
                                    'status',
                                    'internetState',
                                    'ip',
                                    'onlineDetection',
                                    'latency',
                                    'loss',
                                    'rxRate',
                                    'txRate',
                                    'healthLevel',
                                    'proto',
                                ],
                                ['port', 'status', 'internetState']
                            )
                        ),
                    truncated: input.length > MAX_DEVICES,
                };
            }),
            this.read(`${context.base}/dashboard/isp-load`, { start: context.start, end: context.end }, (value) => {
                const budget: SampleBudget = { remaining: context.maxSamples, truncated: false };
                const input = array(value);
                const data = input.slice(0, MAX_DEVICES).map((value) => {
                    const row = record(value);
                    return { ...select(row, ['portId', 'portName'], ['portId']), samples: series(row.data, ['totalRate', 'latency'], budget) };
                });
                return { data, truncated: input.length > MAX_DEVICES || budget.truncated };
            }),
            this.read(`${context.base}/health/gateways/${gateway}/wans/details`, undefined, (value) => {
                const input = Array.isArray(value) ? value : array(record(value).wanDetails);
                return {
                    data: input.slice(0, MAX_DEVICES).map((value) => {
                        const row = record(value);
                        if (!['rxRate', 'txRate', 'latency', 'loss'].some((field) => Object.hasOwn(row, field)))
                            throw new Error('Controller omitted WAN health metrics');
                        return select(
                            row,
                            ['port', 'name', 'ip', 'proto', 'speed', 'duplex', 'rx', 'tx', 'rxRate', 'txRate', 'latency', 'loss'],
                            ['port']
                        );
                    }),
                    truncated: input.length > MAX_DEVICES,
                };
            }),
        ]);
        return this.result(context, { status, ispHistory, health }, [
            'WAN status and health are current snapshots; ISP history uses the requested site-wide window and may include ports from other gateways.',
            'WAN status rates are KB/s, latency ms and loss percent. ISP totalRate retains the controller unit because the API does not specify it.',
            'maxSamples bounds the combined ISP histories. No speed test, WAN reconnect, failover or routing change is started.',
        ]);
    }
}
