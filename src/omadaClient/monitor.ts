import type { OmadaApiResponse } from '../types/index.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

const DEFAULT_WINDOW_SECONDS = 60 * 60;
const MAX_WINDOW_SECONDS = 24 * 60 * 60;
const MAX_DEVICES = 50;

export interface SiteDashboardOptions {
    siteId?: string;
    start?: number;
    end?: number;
}

type Summary = Record<string, unknown>;
export type DashboardSection = { status: 'ok'; data: Summary | Summary[]; truncated: boolean } | { status: 'error' | 'unavailable'; message: string };

export interface SiteDashboardResult {
    capturedAt: number;
    completedAt: number;
    queryWindow: { start: number; end: number; unit: 'seconds' };
    collectionComplete: boolean;
    sections: {
        wifi: DashboardSection;
        traffic: DashboardSection;
        wirelessRates: DashboardSection;
        switches: DashboardSection;
        poe: DashboardSection;
    };
}

function record(value: unknown): Summary {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Controller did not return a dashboard object.');
    }
    return value as Summary;
}

function select(value: unknown, fields: readonly string[], metrics: readonly string[]): Summary {
    const source = record(value);
    for (const metric of metrics) {
        if (!Object.hasOwn(source, metric)) throw new Error(`Controller omitted dashboard metric: ${metric}.`);
        const field = source[metric];
        if (field !== null && (typeof field !== 'number' || !Number.isFinite(field))) {
            throw new Error(`Controller returned an invalid dashboard metric: ${metric}.`);
        }
    }
    const summary: Summary = {};
    for (const key of fields) {
        if (!Object.hasOwn(source, key)) continue;
        const field = source[key];
        if (field === null || typeof field === 'string' || typeof field === 'boolean' || (typeof field === 'number' && Number.isFinite(field))) {
            summary[key] = field;
        } else {
            throw new Error(`Controller returned an invalid dashboard field: ${key}.`);
        }
    }
    if (Object.keys(summary).length === 0) throw new Error('Controller returned no recognized dashboard metrics.');
    return summary;
}

function summarize(value: unknown, fields: readonly string[]): DashboardSection {
    return { status: 'ok', data: select(value, fields, fields), truncated: false };
}

function summarizeList(value: unknown, fields: readonly string[], metrics: readonly string[]): { data: Summary[]; truncated: boolean } {
    if (!Array.isArray(value)) throw new Error('Controller did not return a dashboard device list.');
    return { data: value.slice(0, MAX_DEVICES).map((item) => select(item, fields, metrics)), truncated: value.length > MAX_DEVICES };
}

function summarizeGroups(value: unknown, groups: readonly string[], fields: readonly string[], metrics: readonly string[]): DashboardSection {
    const source = record(value);
    const data: Summary = {};
    let truncated = false;
    for (const group of groups) {
        // An omitted device group is unavailable evidence, not an empty list.
        if (!Object.hasOwn(source, group)) throw new Error(`Controller omitted dashboard device group: ${group}.`);
        const summary = summarizeList(source[group], fields, metrics);
        data[group] = summary.data;
        truncated ||= summary.truncated;
    }
    return { status: 'ok', data, truncated };
}

function summarizePoe(value: unknown): DashboardSection {
    if (!Array.isArray(value)) throw new Error('Controller did not return a dashboard device list.');
    const data = value.slice(0, MAX_DEVICES).map((item) => {
        const source = record(item);
        const ports = source.poePorts;
        const explicitlyUnsupported =
            Array.isArray(ports) &&
            ports.length > 0 &&
            ports.every(
                (port) =>
                    port !== null &&
                    typeof port === 'object' &&
                    !Array.isArray(port) &&
                    Object.hasOwn(port, 'poeSupported') &&
                    port.poeSupported === false
            );
        if (explicitlyUnsupported) {
            return { ...select(source, ['mac', 'name', 'portNum'], ['portNum']), supported: false };
        }
        return select(
            source,
            ['mac', 'name', 'portNum', 'totalPowerUsed', 'totalPercentUsed', 'totalPower'],
            ['portNum', 'totalPowerUsed', 'totalPercentUsed', 'totalPower']
        );
    });
    return { status: 'ok', data, truncated: value.length > MAX_DEVICES };
}

/** Bounded, read-only dashboard summaries; no scans, tests or controller changes. */
export class MonitorOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}

    public async getSiteDashboard(options: SiteDashboardOptions = {}): Promise<SiteDashboardResult> {
        const capturedAt = Date.now();
        const now = Math.floor(capturedAt / 1000);
        const end = options.end ?? now;
        const start = options.start ?? Math.max(0, end - DEFAULT_WINDOW_SECONDS);
        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start >= end ||
            end > now ||
            end - start > MAX_WINDOW_SECONDS
        ) {
            throw new Error('Dashboard start/end must be epoch seconds with 0 <= start < end <= now and a window no longer than 24 hours.');
        }
        const siteId = this.site.resolveSiteId(options.siteId);
        const path = `/sites/${encodeURIComponent(siteId)}/dashboard`;
        const window = { start, end };
        const read = async (endpoint: string, timed: boolean, project: (value: unknown) => DashboardSection): Promise<DashboardSection> => {
            let value: unknown;
            try {
                const response = await this.request.get<OmadaApiResponse<unknown>>(this.buildPath(`${path}/${endpoint}`), timed ? window : undefined);
                value = this.request.ensureSuccess(response);
                if (response.result === undefined || response.result === null) {
                    return { status: 'unavailable', message: 'Controller returned no dashboard data.' };
                }
            } catch (error) {
                return { status: 'error', message: error instanceof Error ? error.message : 'Dashboard request failed.' };
            }
            try {
                return project(value);
            } catch (error) {
                return { status: 'unavailable', message: error instanceof Error ? error.message : 'Dashboard response was not usable.' };
            }
        };
        const [wifi, traffic, wirelessRates, switches, poe] = await Promise.all([
            read('wifi-summary', true, (value) => summarize(value, ['connectedApNum', 'clients', 'channelUtilization', 'totalTraffic'])),
            read('traffic-distribution', true, (value) =>
                summarizeGroups(value, ['aps', 'switches'], ['name', 'mac', 'traffic', 'trafficProportion'], ['traffic', 'trafficProportion'])
            ),
            read('retry-dropped-rate', true, (value) =>
                summarizeGroups(value, ['retryEaps', 'droppedEaps'], ['apMac', 'name', 'avg', 'status'], ['avg'])
            ),
            read('switch-summary', true, (value) => summarize(value, ['clients', 'portUtilization', 'connectedSwitchNum', 'totalTraffic'])),
            read('poe-usage', false, summarizePoe),
        ]);
        const sections = { wifi, traffic, wirelessRates, switches, poe };
        return {
            capturedAt,
            completedAt: Date.now(),
            queryWindow: { ...window, unit: 'seconds' },
            collectionComplete: Object.values(sections).every((section) => section.status === 'ok' && !section.truncated),
            sections,
        };
    }
}
