import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { OmadaDeviceInfo } from '../types/index.js';
import type { SiteDashboardOptions, SiteDashboardResult } from './monitor.js';

const MAX_INVENTORY = 2000;
const RF_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const COLLECTION_BUDGET_MS = 30_000;
const MAC = /^[a-f\d]{12}$/;
const bands = ['2g', '5g', '5g1', '5g2', '6g'] as const;
const RF_STATUS_FIELDS = ['status', 'status2g', 'status5g', 'status5g2', 'status6g'] as const;
const RF_TIME_FIELDS = ['time', 'time2g', 'time5g', 'time6g'] as const;
const configurationSchema = z
    .object({
        enabled: z.boolean().optional(),
        channelIndex: z.number().int().nonnegative().optional(),
        channelWidthCode: z.number().int().nonnegative().optional(),
        txPowerLevel: z.number().int().nonnegative().optional(),
        txPowerDbm: z.number().finite().optional(),
    })
    .strict();
const snapshotApSchema = z
    .object({
        mac: z.string().regex(MAC),
        radios: z.array(z.object({ band: z.enum(bands), configuration: configurationSchema }).strict()).max(5),
    })
    .strict();
export const wifiAuditSnapshotSchema = z
    .object({
        version: z.literal(1),
        scope: z.literal('radio_configuration'),
        controllerId: z.string().min(1).max(128),
        siteId: z.string().min(1).max(128),
        capturedAt: z.number().int().nonnegative(),
        maxAps: z.number().int().min(1).max(25),
        inventoryFingerprint: z.string().regex(/^[a-f\d]{64}$/),
        complete: z.boolean(),
        aps: z.array(snapshotApSchema).max(25),
    })
    .strict();

export const wifiAuditOptionsSchema = z
    .object({
        siteId: z.string().trim().min(1).max(128).optional(),
        maxAps: z.number().int().min(1).max(25).optional(),
        baseline: wifiAuditSnapshotSchema.optional(),
    })
    .strict();

export type GetWifiAuditOptions = z.infer<typeof wifiAuditOptionsSchema>;
export type WifiAuditSnapshot = z.infer<typeof wifiAuditSnapshotSchema>;
type RadioConfiguration = z.infer<typeof configurationSchema>;
type RecordValue = Record<string, unknown>;
interface Failure {
    status: 'error' | 'unavailable';
    reason: string;
    errorCode?: number;
    httpStatus?: number;
}
type Evidence<T> = { status: 'ok' | 'partial'; data: T } | Failure;
interface RadioEvidence {
    band: (typeof bands)[number];
    configuration: RadioConfiguration;
    metrics: {
        actualChannel?: string;
        actualChannelNumber?: number;
        frequencyMHz?: number;
        channelWidth?: string;
        txUtilPercent?: number;
        rxUtilPercent?: number;
        interferenceUtilPercent?: number;
        busyUtilPercent?: number;
    };
}
interface ApEvidence {
    mac: string;
    model?: string;
    inventoryStatus?: string | number;
    radios: Evidence<{ configurationComplete: boolean; retrievedAt: number; freshness: 'unknown'; radios: RadioEvidence[] }>;
    rf: Evidence<{
        measuredAt?: number;
        oldestReportedAt?: number;
        reportedStatuses: Partial<Record<(typeof RF_STATUS_FIELDS)[number], number>>;
        reportedTimes: Partial<Record<(typeof RF_TIME_FIELDS)[number], number>>;
        notes: string[];
        freshness: 'fresh' | 'stale' | 'unknown';
        staleAfterMs: number;
        channelCounts: Partial<Record<(typeof bands)[number], number>>;
    }>;
}
interface DashboardEvidence {
    queryWindow: { start: number; end: number; unit: 'seconds' };
    units: { connectedApNum: 'count'; clients: 'count'; channelUtilization: 'controller_native'; totalTraffic: 'controller_native' };
    wifi: Evidence<Record<string, number | null>>;
    wirelessRates: Evidence<{
        unit: 'controller_native';
        retry: { apMac?: string; avg?: number | null }[];
        dropped: { apMac?: string; avg?: number | null }[];
    }>;
}
export interface WifiAuditResult {
    capturedAt: number;
    completedAt: number;
    siteId: string;
    collectionComplete: boolean;
    inventory: Evidence<{ devicesInspected: number; apsDiscovered: number; selectedAps: number; maxAps: number; truncated: boolean }>;
    dashboard: Evidence<DashboardEvidence>;
    aps: ApEvidence[];
    observations: { code: string; message: string; evidence: string }[];
    snapshot: WifiAuditSnapshot;
    comparison:
        | { status: 'not_requested' | 'not_comparable'; reason: string }
        | {
              status: 'comparable';
              baselineCapturedAt: number;
              currentCapturedAt: number;
              changes: {
                  apMac: string;
                  band: (typeof bands)[number];
                  field: keyof RadioConfiguration;
                  before?: number | boolean;
                  after?: number | boolean;
              }[];
              interpretation: string;
          };
    limitations: string[];
}

export interface WifiAuditClient {
    listDevices(siteId?: string, options?: { signal?: AbortSignal; maxRecords?: number }): Promise<OmadaDeviceInfo[]>;
    getSiteDashboard(options?: SiteDashboardOptions): Promise<SiteDashboardResult>;
    getApRadios(apMac: string, siteId?: string): Promise<{ radioConfig: unknown; radioStats: unknown }>;
    getApRfScanResults(apMac: string, siteId?: string): Promise<unknown>;
}

const record = (value: unknown): RecordValue | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;
const normalizeMac = (value: string): string => value.replace(/[:-]/g, '').toLowerCase();
const numeric = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))) return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
};
function failure(error: unknown, reason: string): Failure {
    const source = record(error);
    return {
        status: 'error',
        reason,
        ...(typeof source?.errorCode === 'number' && Number.isSafeInteger(source.errorCode) ? { errorCode: source.errorCode } : {}),
        ...(typeof source?.status === 'number' && Number.isSafeInteger(source.status) ? { httpStatus: source.status } : {}),
    };
}
function completeConfiguration(value: RadioConfiguration): boolean {
    return (
        typeof value.enabled === 'boolean' &&
        value.channelIndex !== undefined &&
        value.channelWidthCode !== undefined &&
        value.txPowerLevel !== undefined &&
        value.txPowerDbm !== undefined
    );
}
function configuration(raw: RecordValue): RadioConfiguration {
    const output: RadioConfiguration = {};
    if (typeof raw.radioEnable === 'boolean') output.enabled = raw.radioEnable;
    for (const [input, target] of [
        ['channel', 'channelIndex'],
        ['channelWidth', 'channelWidthCode'],
        ['txPowerLevel', 'txPowerLevel'],
        ['txPower', 'txPowerDbm'],
    ] as const) {
        const value = numeric(raw[input]);
        if (value !== undefined && (target === 'txPowerDbm' || (Number.isInteger(value) && value >= 0))) output[target] = value;
    }
    return output;
}
function radioEvidence(value: { radioConfig: unknown; radioStats: unknown }, sampledAt: number): ApEvidence['radios'] {
    const config = record(value.radioConfig),
        stats = record(value.radioStats);
    if (!config) return { status: 'unavailable', reason: 'Controller did not return a radio configuration object.' };
    const radios: RadioEvidence[] = [];
    let complete = true,
        metricsPresent = true;
    for (const band of bands) {
        const raw = record(config[`radioSetting${band}`]);
        if (!raw) continue;
        const configured = configuration(raw);
        complete &&= completeConfiguration(configured);
        const metrics: RadioEvidence['metrics'] = {};
        const values = record(stats?.[`wp${band}`]);
        if (typeof values?.actualChannel === 'string' && values.actualChannel.length <= 32 && /^[\d, /-]+$/.test(values.actualChannel))
            metrics.actualChannel = values.actualChannel;
        if (typeof values?.actualChannel === 'string' && values.actualChannel.length <= 32) {
            const match = values.actualChannel.trim().match(/^(\d+)(?:\s*\/\s*(\d+)\s*MHz)?$/i);
            if (match) {
                const channel = Number(match[1]),
                    frequency = match[2] === undefined ? undefined : Number(match[2]);
                const expected = band === '2g' ? (channel === 14 ? 2484 : 2407 + 5 * channel) : (band === '6g' ? 5950 : 5000) + 5 * channel;
                const allowed =
                    band === '2g' ? channel >= 1 && channel <= 14 : band === '6g' ? channel >= 1 && channel <= 233 : channel >= 32 && channel <= 177;
                if (allowed && (frequency === undefined || frequency === expected)) {
                    metrics.actualChannel = values.actualChannel;
                    metrics.actualChannelNumber = channel;
                    if (frequency !== undefined) metrics.frequencyMHz = frequency;
                }
            }
        }
        if (typeof values?.bandWidth === 'string' && values.bandWidth.length <= 32 && /^[\d,. /-]+(?:MHz)?$/i.test(values.bandWidth))
            metrics.channelWidth = values.bandWidth;
        for (const [source, target] of [
            ['txUtil', 'txUtilPercent'],
            ['rxUtil', 'rxUtilPercent'],
            ['interUtil', 'interferenceUtilPercent'],
            ['busyUtil', 'busyUtilPercent'],
        ] as const) {
            const percent = numeric(values?.[source]);
            if (percent !== undefined && percent >= 0 && percent <= 100) metrics[target] = percent;
        }
        metricsPresent &&= Object.keys(metrics).length > 0;
        radios.push({ band, configuration: configured, metrics });
    }
    if (!radios.length) return { status: 'unavailable', reason: 'Controller returned no recognized radio bands.' };
    return {
        status: complete && metricsPresent ? 'ok' : 'partial',
        data: { configurationComplete: complete, retrievedAt: sampledAt, freshness: 'unknown', radios },
    };
}
function rfEvidence(value: unknown, now: number): ApEvidence['rf'] {
    const raw = record(value);
    if (!raw || (raw.status !== 0 && !RF_STATUS_FIELDS.slice(1).some((field) => raw[field] === 0)))
        return {
            status: 'unavailable',
            reason:
                raw?.status === 1
                    ? 'No saved RF scan result.'
                    : raw?.status === 2
                      ? 'The controller reports a scan in progress; this audit did not start it.'
                      : 'Saved RF scan status is unknown.',
        };
    const time = raw.time;
    const measuredAt = typeof time === 'number' && Number.isSafeInteger(time) && time > 0 ? time : undefined;
    const reportedTimes: Partial<Record<(typeof RF_TIME_FIELDS)[number], number>> = {};
    for (const field of RF_TIME_FIELDS) {
        const time = raw[field];
        if (typeof time === 'number' && Number.isSafeInteger(time) && time > 0) reportedTimes[field] = time;
    }
    const times = Object.values(reportedTimes);
    const oldestReportedAt = times.length ? Math.min(...times) : undefined;
    const invalidTimes = RF_TIME_FIELDS.some((field) => {
        const value = raw[field];
        return Object.hasOwn(raw, field) && value !== 0 && !(typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
    });
    const freshness =
        invalidTimes || oldestReportedAt === undefined || times.some((time) => time > now + 60_000)
            ? 'unknown'
            : now - oldestReportedAt > RF_STALE_AFTER_MS
              ? 'stale'
              : 'fresh';
    const reportedStatuses: Partial<Record<(typeof RF_STATUS_FIELDS)[number], number>> = {};
    const invalidStatuses = RF_STATUS_FIELDS.filter((field) => {
        const value = raw[field];
        return Object.hasOwn(raw, field) && !(typeof value === 'number' && [0, 1, 2].includes(value));
    });
    for (const field of RF_STATUS_FIELDS) if (raw[field] === 0 || raw[field] === 1 || raw[field] === 2) reportedStatuses[field] = raw[field];
    const statusesComplete = raw.status === 0 && invalidStatuses.length === 0 && Object.values(reportedStatuses).every((status) => status === 0);
    const channelCounts: Partial<Record<(typeof bands)[number], number>> = {};
    for (const band of bands) if (Array.isArray(raw[`channel${band}`])) channelCounts[band] = (raw[`channel${band}`] as unknown[]).length;
    return {
        status: statusesComplete && freshness === 'fresh' && Object.keys(channelCounts).length > 0 ? 'ok' : 'partial',
        data: {
            ...(measuredAt === undefined ? {} : { measuredAt }),
            ...(oldestReportedAt === undefined ? {} : { oldestReportedAt }),
            reportedStatuses,
            reportedTimes,
            notes: [
                ...(invalidStatuses.length ? ['Some reported scan statuses could not be interpreted.'] : []),
                ...(invalidTimes ? ['Some reported scan timestamps could not be interpreted.'] : []),
                ...(reportedTimes.time2g !== undefined
                    ? ['The exact time2g field is retained without assigning its ambiguous documented band meaning.']
                    : []),
            ],
            freshness,
            staleAfterMs: RF_STALE_AFTER_MS,
            channelCounts,
        },
    };
}
function dashboardEvidence(value: SiteDashboardResult): Evidence<DashboardEvidence> {
    const wifiSource = value.sections.wifi;
    let wifi: DashboardEvidence['wifi'] = { status: 'unavailable', reason: 'Wi-Fi dashboard metrics were unavailable.' };
    if (wifiSource.status === 'ok') {
        const source = record(wifiSource.data),
            data: Record<string, number | null> = {};
        for (const key of ['connectedApNum', 'clients', 'channelUtilization', 'totalTraffic']) {
            if (source?.[key] === null) data[key] = null;
            else if (typeof source?.[key] === 'number' && Number.isFinite(source[key])) data[key] = source[key] as number;
        }
        if (Object.keys(data).length)
            wifi = {
                status:
                    Object.keys(data).length === 4 && Object.values(data).every((value) => value !== null) && !wifiSource.truncated
                        ? 'ok'
                        : 'partial',
                data,
            };
    }
    const ratesSource = value.sections.wirelessRates;
    let wirelessRates: DashboardEvidence['wirelessRates'] = { status: 'unavailable', reason: 'Retry/drop dashboard metrics were unavailable.' };
    if (ratesSource.status === 'ok') {
        const source = record(ratesSource.data);
        const rows = (name: string) =>
            Array.isArray(source?.[name])
                ? (source[name] as unknown[]).slice(0, 25).map((item) => {
                      const row = record(item),
                          mac = typeof row?.apMac === 'string' ? normalizeMac(row.apMac) : undefined;
                      return {
                          ...(mac && MAC.test(mac) ? { apMac: mac } : {}),
                          ...(row?.avg === null || (typeof row?.avg === 'number' && Number.isFinite(row.avg))
                              ? { avg: row.avg as number | null }
                              : {}),
                      };
                  })
                : undefined;
        const retry = rows('retryEaps'),
            dropped = rows('droppedEaps');
        if (retry && dropped)
            wirelessRates = {
                status:
                    ratesSource.truncated ||
                    (Array.isArray(source?.retryEaps) && source.retryEaps.length > 25) ||
                    (Array.isArray(source?.droppedEaps) && source.droppedEaps.length > 25)
                        ? 'partial'
                        : 'ok',
                data: { unit: 'controller_native', retry, dropped },
            };
    }
    return {
        status: wifi.status === 'ok' && wirelessRates.status === 'ok' ? 'ok' : 'partial',
        data: {
            queryWindow: { start: value.queryWindow.start, end: value.queryWindow.end, unit: 'seconds' },
            units: { connectedApNum: 'count', clients: 'count', channelUtilization: 'controller_native', totalTraffic: 'controller_native' },
            wifi,
            wirelessRates,
        },
    };
}
function compare(baseline: WifiAuditSnapshot | undefined, current: WifiAuditSnapshot): WifiAuditResult['comparison'] {
    if (!baseline) return { status: 'not_requested', reason: 'Save snapshot and pass it as baseline for a configuration comparison.' };
    if (!baseline.complete || !current.complete)
        return { status: 'not_comparable', reason: 'Both radio-configuration snapshots must have complete inventory and configuration evidence.' };
    if (
        baseline.controllerId !== current.controllerId ||
        baseline.siteId !== current.siteId ||
        baseline.maxAps !== current.maxAps ||
        baseline.inventoryFingerprint !== current.inventoryFingerprint
    )
        return { status: 'not_comparable', reason: 'Controller, site, AP inventory or collection scope differs.' };
    if (baseline.capturedAt > current.capturedAt) return { status: 'not_comparable', reason: 'Baseline capture time is after the current capture.' };
    const canonical = (aps: WifiAuditSnapshot['aps']) => [...aps].sort((a, b) => a.mac.localeCompare(b.mac));
    const before = canonical(baseline.aps),
        after = canonical(current.aps);
    if (
        new Set(before.map((ap) => ap.mac)).size !== before.length ||
        before.length !== after.length ||
        before.some((ap, i) => ap.mac !== after[i].mac)
    )
        return { status: 'not_comparable', reason: 'Selected AP identities differ or are duplicated.' };
    const changes: Extract<WifiAuditResult['comparison'], { status: 'comparable' }>['changes'] = [];
    for (let i = 0; i < after.length; i++) {
        const previous = [...before[i].radios].sort((a, b) => a.band.localeCompare(b.band)),
            next = [...after[i].radios].sort((a, b) => a.band.localeCompare(b.band));
        if (
            new Set(previous.map((r) => r.band)).size !== previous.length ||
            previous.length !== next.length ||
            previous.some((radio, j) => radio.band !== next[j].band) ||
            [...previous, ...next].some((r) => !completeConfiguration(r.configuration))
        )
            return { status: 'not_comparable', reason: 'Radio bands or required configuration evidence differ.' };
        for (let j = 0; j < next.length; j++)
            for (const field of ['enabled', 'channelIndex', 'channelWidthCode', 'txPowerLevel', 'txPowerDbm'] as const) {
                const old = previous[j].configuration[field],
                    value = next[j].configuration[field];
                if ((old === undefined) !== (value === undefined))
                    return { status: 'not_comparable', reason: 'Comparable configuration fields differ between snapshots.' };
                if (old !== value) changes.push({ apMac: after[i].mac, band: next[j].band, field, before: old, after: value });
            }
    }
    return {
        status: 'comparable',
        baselineCapturedAt: baseline.capturedAt,
        currentCapturedAt: current.capturedAt,
        changes,
        interpretation: 'Configuration differences only; this comparison does not establish performance improvement or causality.',
    };
}

/** Bounded Wi-Fi evidence collection; no scan or mutation methods are part of this interface. */
export class WifiAuditOperations {
    constructor(
        private readonly client: WifiAuditClient,
        private readonly config: { omadacId: string; siteId?: string }
    ) {}

    public async diagnoseWifi(options: GetWifiAuditOptions = {}): Promise<WifiAuditResult> {
        if (Buffer.byteLength(JSON.stringify(options)) > 128 * 1024) throw new Error('Wi-Fi audit input exceeds 128 KiB.');
        const parsed = wifiAuditOptionsSchema.parse(options);
        const siteId = parsed.siteId ?? this.config.siteId;
        if (!siteId) throw new Error('A site ID is required for the Wi-Fi audit.');
        if (siteId.length > 128 || !this.config.omadacId || this.config.omadacId.length > 128)
            throw new Error('Audit identity fields must contain 1 to 128 characters.');
        const maxAps = parsed.maxAps ?? 10,
            capturedAt = Date.now();
        const deadline = capturedAt + COLLECTION_BUDGET_MS;
        const collectionAbort = new AbortController();
        const read = <T>(operation: () => Promise<T>): Promise<T> => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) return Promise.reject(new Error('Collection budget exhausted'));
            return new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => {
                    collectionAbort.abort();
                    reject(new Error('Collection budget exhausted'));
                }, remaining);
                Promise.resolve()
                    .then(operation)
                    .then(
                        (value) => {
                            clearTimeout(timer);
                            resolve(value);
                        },
                        (error) => {
                            clearTimeout(timer);
                            reject(error);
                        }
                    );
            });
        };
        const end = Math.floor(capturedAt / 1000),
            start = Math.max(0, end - 3600);
        const dashboardPromise = read(() => this.client.getSiteDashboard({ siteId, start, end }))
            .then(dashboardEvidence)
            .catch((error) => failure(error, 'Site dashboard could not be collected within the collection budget.'));
        let inventory: WifiAuditResult['inventory'],
            selected: OmadaDeviceInfo[] = [],
            inventoryFingerprint = createHash('sha256').update('unavailable').digest('hex');
        try {
            const devices = await read(() => this.client.listDevices(siteId, { signal: collectionAbort.signal, maxRecords: MAX_INVENTORY }));
            if (!Array.isArray(devices)) throw new Error('Invalid device inventory');
            const inspected = devices.slice(0, MAX_INVENTORY);
            const unknownTypes = inspected.some((device) => !['ap', 'switch', 'gateway'].includes(device.type ?? ''));
            const aps = inspected.filter((device) => device.type === 'ap');
            const identities = aps.map((device) => normalizeMac(device.mac));
            const valid = identities.every((mac) => MAC.test(mac)) && new Set(identities).size === identities.length;
            const truncated = devices.length > MAX_INVENTORY || aps.length > maxAps;
            selected = valid ? aps.sort((a, b) => normalizeMac(a.mac).localeCompare(normalizeMac(b.mac))).slice(0, maxAps) : [];
            inventoryFingerprint = createHash('sha256').update(JSON.stringify(identities.sort())).digest('hex');
            inventory = {
                status: valid && !truncated && !unknownTypes ? 'ok' : 'partial',
                data: {
                    devicesInspected: Math.min(devices.length, MAX_INVENTORY),
                    apsDiscovered: aps.length,
                    selectedAps: selected.length,
                    maxAps,
                    truncated,
                },
            };
        } catch (error) {
            inventory = failure(error, 'AP inventory could not be collected.');
        }
        const aps: ApEvidence[] = [];
        for (const device of selected) {
            const [radios, rf] = await Promise.all([
                read(() => this.client.getApRadios(device.mac, siteId))
                    .then((value) => radioEvidence(value, Date.now()))
                    .catch((error) => failure(error, 'Radio evidence could not be collected within the collection budget.')),
                read(() => this.client.getApRfScanResults(device.mac, siteId))
                    .then((value) => rfEvidence(value, capturedAt))
                    .catch((error) => failure(error, 'Saved RF evidence could not be collected within the collection budget.')),
            ]);
            aps.push({
                mac: normalizeMac(device.mac),
                ...(typeof device.model === 'string' ? { model: device.model.slice(0, 128) } : {}),
                ...(['string', 'number'].includes(typeof device.status) ? { inventoryStatus: device.status as string | number } : {}),
                radios,
                rf,
            });
        }
        const dashboard = await dashboardPromise;
        const observations: WifiAuditResult['observations'] = [];
        for (const [i, ap] of aps.entries()) {
            if (ap.radios.status !== 'ok')
                observations.push({
                    code: 'radio_evidence_incomplete',
                    message: 'Radio evidence is incomplete; no healthy-radio inference is made.',
                    evidence: `aps[${i}].radios`,
                });
            if (ap.rf.status !== 'ok')
                observations.push({
                    code: 'rf_evidence_incomplete',
                    message: 'Saved RF evidence is missing, stale or incomplete. No scan was started.',
                    evidence: `aps[${i}].rf`,
                });
            if ('data' in ap.radios)
                for (const radio of ap.radios.data.radios)
                    if (radio.configuration.enabled === false)
                        observations.push({
                            code: 'radio_disabled',
                            message: `The ${radio.band} radio is reported disabled; this may be intentional.`,
                            evidence: `aps[${i}].radios`,
                        });
        }
        if (inventory.status !== 'ok')
            observations.push({
                code: 'inventory_incomplete',
                message: 'AP inventory scope is incomplete or contains invalid identities.',
                evidence: 'inventory',
            });
        if (inventory.status === 'ok' && selected.length === 0)
            observations.push({ code: 'no_aps_reported', message: 'The collected device inventory contains no APs.', evidence: 'inventory' });
        if (dashboard.status !== 'ok')
            observations.push({ code: 'dashboard_incomplete', message: 'Wi-Fi dashboard evidence is incomplete.', evidence: 'dashboard' });
        const snapshot: WifiAuditSnapshot = {
            version: 1,
            scope: 'radio_configuration',
            controllerId: this.config.omadacId,
            siteId,
            capturedAt,
            maxAps,
            inventoryFingerprint,
            complete: inventory.status === 'ok' && aps.every((ap) => 'data' in ap.radios && ap.radios.data.configurationComplete),
            aps: aps.map((ap) => ({
                mac: ap.mac,
                radios: 'data' in ap.radios ? ap.radios.data.radios.map(({ band, configuration }) => ({ band, configuration })) : [],
            })),
        };
        return {
            capturedAt,
            completedAt: Date.now(),
            siteId,
            collectionComplete:
                inventory.status === 'ok' && dashboard.status === 'ok' && aps.every((ap) => ap.radios.status === 'ok' && ap.rf.status === 'ok'),
            inventory,
            dashboard,
            aps,
            observations,
            snapshot,
            comparison: compare(parsed.baseline, snapshot),
            limitations: [
                'Evidence-only audit; no health score, root-cause or performance improvement is inferred.',
                'RF freshness uses a 24-hour policy and documented epoch-millisecond timestamps; missing/future times remain unknown.',
                'Radio channelIndex and channelWidthCode are controller configuration codes; txPowerDbm and utilization percentages retain explicit units. Dashboard traffic/utilization and retry/drop averages remain controller-native and are not converted or compared.',
                'Collection has a 30-second response budget. No new audit method calls start afterward; in-flight methods may finish under their client timeouts. Inventory pagination is record-bounded and receives cancellation.',
                'Baseline comparison covers only the five summarized configuration fields; all must be available for every selected radio. Save snapshot externally; no server-side files are written.',
            ],
        };
    }
}
