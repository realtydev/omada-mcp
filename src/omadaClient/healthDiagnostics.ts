import type { OmadaApiResponse, OmadaDeviceInfo } from '../types/index.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';
import type { SwitchPortOverview } from './switchPortRead.js';

type Row = Record<string, unknown>;
export interface NativeEvidence<T> {
    source: string;
    collectedAt: number;
    status: 'ok' | 'partial' | 'forbidden' | 'unsupported' | 'unavailable' | 'unknown';
    data?: T;
    reason?: string;
    httpStatus?: number;
    errorCode?: number;
}
export interface NativePage<T> {
    records: T[];
    totalRows?: number;
    truncated: boolean;
    completenessKnown: boolean;
    invalidRecords: number;
}
export interface LldpNeighbor extends Row {
    portId: number;
    deviceId: string;
    neighborMac?: string;
    standardPort?: string;
    standardPortIndex?: { unit: number; slot: number; port: number };
    neighborPortId?: string;
    ttl?: number;
}
export type LldpEvidence = NativeEvidence<NativePage<LldpNeighbor>> & { switchMac: string };
export interface SiteHealthReport {
    readOnly: true;
    capturedAt: number;
    completedAt: number;
    queryWindow: { start: number; end: number; unit: 'milliseconds' };
    collectionComplete: boolean;
    sections: {
        timeline: NativeEvidence<{ scores: Row[]; truncated: boolean; invalidRecords: number; missingScores: number }>;
        incidents: NativeEvidence<NativePage<Row>>;
    };
    limitations: string[];
}
const PAGE_SIZE = 100;
const MAX_SCORES = 512;
const row = (v: unknown): Row | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : undefined);
const str = (v: unknown, max = 256): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function evidenceMac(v: unknown): string | undefined {
    return typeof v === 'string' && /^(?:[a-f\d]{12}|(?:[a-f\d]{2}[:-]){5}[a-f\d]{2})$/i.test(v)
        ? v.replace(/[:-]/g, '').toUpperCase().match(/.{2}/g)!.join('-')
        : undefined;
}
function unavailable<T>(source: string, error: unknown): NativeEvidence<T> {
    const e = row(error),
        response = row(e?.response),
        body = row(response?.data);
    const httpStatus = e?.status ?? response?.status,
        errorCode = e?.errorCode ?? body?.errorCode;
    return {
        source,
        collectedAt: Date.now(),
        status:
            httpStatus === 401 || httpStatus === 403 || [-44106, -44112, -44113].includes(Number(errorCode))
                ? 'forbidden'
                : [404, 405, 501].includes(Number(httpStatus)) || errorCode === -1600
                  ? 'unsupported'
                  : error instanceof TypeError
                    ? 'unknown'
                    : 'unavailable',
        reason: 'Requested controller evidence could not be established; other sections remain available.',
        ...(integer(httpStatus) ? { httpStatus } : {}),
        ...(typeof errorCode === 'number' && Number.isSafeInteger(errorCode) ? { errorCode } : {}),
    };
}
function page<T>(value: unknown, project: (v: unknown) => T | undefined): NativePage<T> {
    const r = row(value);
    if (!r || !Array.isArray(r.data) || (r.currentPage !== undefined && r.currentPage !== 1)) throw new TypeError('Unusable grid');
    const records: T[] = [];
    let invalidRecords = 0;
    for (const item of r.data.slice(0, PAGE_SIZE)) {
        const p = project(item);
        if (p === undefined) invalidRecords++;
        else records.push(p);
    }
    const countKnown =
        integer(r.totalRows) && r.totalRows >= r.data.length && r.currentPage === 1 && r.currentSize === PAGE_SIZE && r.data.length <= PAGE_SIZE;
    return {
        records,
        ...(countKnown ? { totalRows: r.totalRows as number } : {}),
        completenessKnown: countKnown,
        truncated: r.data.length > PAGE_SIZE || (countKnown ? Number(r.totalRows) > r.data.length : r.data.length >= PAGE_SIZE),
        invalidRecords,
    };
}
function complete<T>(value: NativePage<T>): boolean {
    return value.completenessKnown && !value.truncated && value.invalidRecords === 0;
}

/** Fixed read contracts only; native scores and LLDP advertisements are evidence, not health/path assertions. */
export class HealthDiagnosticsOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}
    private async read<T>(
        source: string,
        path: string,
        params: Row,
        project: (value: unknown) => T,
        isComplete: (v: T) => boolean
    ): Promise<NativeEvidence<T>> {
        try {
            const response = await this.request.request<OmadaApiResponse<unknown>>({
                method: 'GET',
                url: this.buildPath(path),
                params,
                timeout: 10_000,
                maxContentLength: 1024 * 1024,
                maxRedirects: 0,
            });
            const data = project(this.request.ensureSuccess(response));
            return { source, collectedAt: Date.now(), status: isComplete(data) ? 'ok' : 'partial', data };
        } catch (error) {
            return unavailable(source, error);
        }
    }
    async getSiteHealth(siteId?: string, start?: number, end?: number): Promise<SiteHealthReport> {
        end ??= Date.now();
        start ??= end - 86_400_000;
        if (!integer(start) || !integer(end) || start > end || end - start > 86_400_000 || end > Date.now())
            throw new Error('Health window must be a past window of at most 24 hours in epoch milliseconds.');
        const capturedAt = Date.now(),
            base = `/sites/${encodeURIComponent(this.site.resolveSiteId(siteId))}`;
        const [timeline, incidents] = await Promise.all([
            this.read(
                'getSiteHealthTimeList',
                `${base}/health/timeline`,
                { start, end },
                (value) => {
                    const r = row(value);
                    if (!r || !Array.isArray(r.scores)) throw new TypeError('Unusable health timeline');
                    let invalidRecords = 0,
                        missingScores = 0;
                    const scores: Row[] = [],
                        times = new Set<number>();
                    for (const value of r.scores.slice(0, MAX_SCORES)) {
                        const s = row(value),
                            time = s?.time;
                        if (!s || !integer(time) || time < start || time > end || times.has(time)) {
                            invalidRecords++;
                            continue;
                        }
                        times.add(time);
                        const score: Row = { time };
                        for (const key of ['siteHealthScore', 'deviceHealthScore', 'clientHealthScore', 'wifiHealthScore', 'wanHealthScore']) {
                            if (integer(s[key]) && Number(s[key]) <= 2147483647) score[key] = s[key];
                            else missingScores++;
                        }
                        scores.push(score);
                    }
                    return { scores, truncated: r.scores.length > MAX_SCORES, invalidRecords, missingScores };
                },
                (v) => !v.truncated && v.invalidRecords === 0 && v.missingScores === 0 && v.scores.length > 0
            ),
            this.read(
                'getGridIncidentList',
                `${base}/anomaly/incidents`,
                { page: 1, pageSize: PAGE_SIZE, 'filters.startTime': start, 'filters.endTime': end },
                (value) =>
                    page(value, (value) => {
                        const r = row(value),
                            last = r?.lastTime;
                        if (!r || !str(r.anomalyCode) || !integer(last) || last < start || last > end) return undefined;
                        const result: Row = { anomalyCode: r.anomalyCode, lastTime: last };
                        for (const k of ['category', 'level', 'count', 'status']) if (integer(r[k])) result[k] = r[k];
                        if (integer(r.firstTime) && r.firstTime <= last) result.firstTime = r.firstTime;
                        if (str(r.objectType)) result.objectType = r.objectType;
                        if (Array.isArray(r.object)) result.object = r.object.slice(0, 16).filter((v) => str(v));
                        return result;
                    }),
                complete
            ),
        ]);
        return {
            readOnly: true,
            capturedAt,
            completedAt: Date.now(),
            queryWindow: { start, end, unit: 'milliseconds' },
            collectionComplete: timeline.status === 'ok' && incidents.status === 'ok',
            sections: { timeline, incidents },
            limitations: [
                'Scores retain controller-native values; no score scale, cause or healthy-state threshold is inferred.',
                'Incidents are historical aggregates within the requested window. Their native status does not independently prove a current outage or recovery.',
                'Timeline and incident reads are independent, bounded and may be cached. Missing scores and empty timelines remain incomplete evidence.',
            ],
        };
    }
    async getSwitchLldpNeighbors(switchMac: string, siteId?: string): Promise<LldpEvidence> {
        const mac = evidenceMac(switchMac);
        if (!mac) throw new Error('switchMac must be a full MAC address.');
        const source = 'getGridLldpNeighborTable';
        const evidence = await this.read(
            source,
            `/sites/${encodeURIComponent(this.site.resolveSiteId(siteId))}/switches/${encodeURIComponent(mac)}/lldp-neighbors`,
            { page: 1, pageSize: PAGE_SIZE },
            (value) => {
                const result = page<LldpNeighbor>(value, (value) => {
                    const r = row(value);
                    if (!r || !integer(r.portId) || r.portId < 1 || r.portId > 65535 || !str(r.deviceId)) return undefined;
                    const result: LldpNeighbor = { portId: r.portId, deviceId: r.deviceId as string };
                    for (const k of ['standardPort', 'systemName', 'neighborPortId', 'capabilities']) if (str(r[k])) result[k] = r[k];
                    if (r.standardPort !== undefined && result.standardPort === undefined) result.identityConflict = true;
                    const index = row(r.standardPortIndex);
                    if (index && integer(index.unit) && index.unit > 0 && integer(index.slot) && integer(index.port) && index.port === r.portId)
                        result.standardPortIndex = { unit: index.unit, slot: index.slot, port: index.port };
                    if (r.standardPortIndex !== undefined && result.standardPortIndex === undefined) result.identityConflict = true;
                    if (integer(r.ttl)) result.ttl = r.ttl;
                    const neighborMac = evidenceMac(r.deviceId);
                    if (neighborMac) result.neighborMac = neighborMac;
                    return result;
                });
                const seen = new Set<number>(),
                    duplicates = new Set<number>();
                for (const p of result.records) {
                    if (seen.has(p.portId)) duplicates.add(p.portId);
                    seen.add(p.portId);
                }
                result.invalidRecords += result.records.filter((p) => duplicates.has(p.portId)).length;
                result.records = result.records.filter((p) => !duplicates.has(p.portId));
                return result;
            },
            complete
        );
        return { ...evidence, switchMac: mac };
    }
}

export interface LldpCorrelation {
    switchMac: string;
    neighborMac: string;
    port: number;
    standardPort: { unit: 1; slot: 0; port: number };
    neighborPortId?: string;
    basis: 'lldp_advertisement';
}
/** Corroborates existing device relationships only; never uses advertised names to establish identity. */
export function correlateLldp(
    evidence: LldpEvidence,
    overview: SwitchPortOverview | undefined,
    inventory: OmadaDeviceInfo[],
    allowedNeighbors?: Set<string>
): LldpCorrelation[] {
    if (
        !evidence.data ||
        evidence.status !== 'ok' ||
        evidence.data.truncated ||
        !overview ||
        overview.inventoryStatus !== 'ok' ||
        overview.inventoryTruncated
    )
        return [];
    const mac = evidenceMac(evidence.switchMac),
        coverage = overview.switches.filter((s) => evidenceMac(s.switchMac) === mac);
    if (!mac || coverage.length !== 1 || coverage[0].inventoryKnown !== true) return [];
    const ports = overview.ports.filter((p) => evidenceMac(p.switchMac) === mac);
    if (
        !ports.length ||
        ports.some((p) => {
            const identity = row(p.standardPort);
            return !identity || identity.unit !== 1 || identity.slot !== 0 || identity.port !== p.port;
        })
    )
        return [];
    const ids = new Set<number>();
    for (const p of ports) {
        if (!integer(p.port) || ids.has(p.port)) return [];
        ids.add(p.port);
    }
    const known = new Map<string, number>();
    for (const d of inventory) {
        const m = evidenceMac(d.mac);
        if (m) known.set(m, (known.get(m) ?? 0) + 1);
    }
    if (known.get(mac) !== 1) return [];
    return evidence.data.records.flatMap((p): LldpCorrelation[] => {
        if (p.identityConflict === true) return [];
        if (
            !p.neighborMac ||
            p.neighborMac === mac ||
            known.get(p.neighborMac) !== 1 ||
            p.ttl === undefined ||
            p.ttl === 0 ||
            !ids.has(p.portId) ||
            (allowedNeighbors && !allowedNeighbors.has(p.neighborMac))
        )
            return [];
        const standard = p.standardPort?.match(/^[a-zA-Z]{0,24}(\d+)\/(\d+)\/(\d+)$/);
        const index = p.standardPortIndex;
        if (p.standardPort !== undefined && (!standard || Number(standard[1]) !== 1 || Number(standard[2]) !== 0 || Number(standard[3]) !== p.portId))
            return [];
        if (index && (index.unit !== 1 || index.slot !== 0 || index.port !== p.portId)) return [];
        if (!standard && !index) return [];
        return [
            {
                switchMac: mac,
                neighborMac: p.neighborMac,
                port: p.portId,
                standardPort: { unit: 1, slot: 0, port: p.portId },
                ...(p.neighborPortId ? { neighborPortId: p.neighborPortId } : {}),
                basis: 'lldp_advertisement',
            },
        ];
    });
}
