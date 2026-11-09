import { z } from 'zod';
import type { OmadaClientInfo, OmadaDeviceInfo, PaginatedResult } from '../types/index.js';
import { networkFindings } from './networkFindings.js';
import type { PaginationReadOptions } from './request.js';
import type { SiteOperations } from './site.js';
import type { SwitchPortOverview } from './switchPortRead.js';
import type { GetWifiAuditOptions, WifiAuditResult } from './wifiAudit.js';

type Row = Record<string, unknown>;
export const networkDiagnosisOptionsSchema = z
    .object({
        siteId: z.string().min(1).optional(),
        hours: z.number().int().min(1).max(24).default(24),
        maxAps: z.number().int().min(1).max(20).default(10),
        weakRssiDbm: z.number().int().min(-90).max(-60).default(-75),
    })
    .strict();
export type NetworkDiagnosisOptions = z.input<typeof networkDiagnosisOptionsSchema>;
export interface NetworkDiagnosisClient {
    listDevices(siteId?: string, options?: PaginationReadOptions): Promise<OmadaDeviceInfo[]>;
    listClients(siteId?: string, options?: PaginationReadOptions): Promise<OmadaClientInfo[]>;
    diagnoseWifi(options: GetWifiAuditOptions): Promise<WifiAuditResult>;
    diagnoseWan(options: { gatewayMac: string; siteId?: string; start?: number; end?: number; maxSamples?: number }): Promise<unknown>;
    getSwitchPortOverview(switchMac?: string, siteId?: string): Promise<SwitchPortOverview>;
    getSiteTopology(siteId?: string): Promise<unknown>;
    getApSsidOverrides(apMac: string, siteId?: string): Promise<unknown>;
    getRfPlanningStatus(options: { siteId?: string }): Promise<unknown>;
    listEvents(
        siteId?: string,
        page?: number,
        pageSize?: number,
        start?: number,
        end?: number,
        module?: 'System' | 'Device' | 'Client',
        keyPrefix?: string,
        excludePrefix?: string,
        scanOptions?: { maxPages: number }
    ): Promise<PaginatedResult<unknown> & { scanTruncated?: boolean }>;
    listAlerts(siteId?: string, page?: number, pageSize?: number, start?: number, end?: number): Promise<PaginatedResult<unknown>>;
}
type Evidence<T> =
    | { status: 'ok' | 'partial'; source: string; collectedAt: number; data: T }
    | { status: 'forbidden' | 'unsupported' | 'unavailable' | 'unknown'; source: string; collectedAt: number; reason: string; httpStatus?: number };
const obj = (v: unknown): Row | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : undefined);
function object(v: unknown): Row {
    const r = obj(v);
    if (!r) throw new TypeError('Unusable object evidence');
    return r;
}
const text = (v: unknown, max = 256) => (typeof v === 'string' && v.length <= max ? v : undefined);
const numeric = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function mac(v: unknown): string {
    if (typeof v !== 'string' || !/^(?:[a-f\d]{12}|(?:[a-f\d]{2}[:-]){5}[a-f\d]{2})$/i.test(v)) throw new TypeError('Unusable MAC evidence');
    return v.replace(/[:-]/g, '').match(/.{2}/g)!.join('-').toUpperCase();
}
function optionalMac(v: unknown): string | undefined {
    try {
        return mac(v);
    } catch {
        return undefined;
    }
}
const fields = (v: Row, keys: string[]) => Object.fromEntries(keys.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));
function inventory(v: unknown, clients = false): Row[] {
    if (!Array.isArray(v) || v.length > 1000) throw new TypeError('Unusable inventory');
    const seen = new Set<string>();
    return v.map((value) => {
        const r = object(value),
            id = mac(r.mac);
        if (seen.has(id)) throw new TypeError('Duplicate inventory identity');
        seen.add(id);
        const status = numeric(r.status) ?? (typeof r.status === 'string' && /^\d{1,3}$/.test(r.status) ? Number(r.status) : undefined);
        if (!clients)
            return {
                mac: id,
                name: text(r.name),
                model: text(r.model),
                type: text(r.type),
                status: status !== undefined && Number.isSafeInteger(status) && status >= 0 ? status : undefined,
            };
        const signal = numeric(r.rssi),
            snr = numeric(r.snr),
            health = numeric(r.healthScore);
        return {
            mac: id,
            name: text(r.name),
            wireless: typeof r.wireless === 'boolean' ? r.wireless : undefined,
            active: typeof r.active === 'boolean' ? r.active : undefined,
            apMac: optionalMac(r.apMac),
            apName: text(r.apName),
            ssid: text(r.ssid),
            channel: numeric(r.channel),
            radioId: numeric(r.radioId),
            rssi: signal !== undefined && signal >= -126 && signal < 0 ? signal : undefined,
            snr: snr !== undefined && snr >= 0 && snr <= 100 ? snr : undefined,
            healthScore: health !== undefined && health >= 0 ? health : null,
            lastSeen: numeric(r.lastSeen),
        };
    });
}
function grid(v: unknown, cap: number, start: number, end: number) {
    const r = object(v);
    if (!Array.isArray(r.data) || r.data.length > cap || (r.currentPage !== undefined && r.currentPage !== 1))
        throw new TypeError('Unusable log page');
    let invalid = 0;
    const records: Row[] = [];
    const seen = new Set<string>();
    for (const value of r.data) {
        const e = obj(value),
            time = numeric(e?.time),
            id = text(e?.id);
        if (
            !e ||
            time === undefined ||
            !Number.isSafeInteger(time) ||
            time < start ||
            time > end ||
            text(e.key) === undefined ||
            text(e.content, 2048) === undefined ||
            (id !== undefined && seen.has(id))
        ) {
            invalid++;
            continue;
        }
        if (id !== undefined) seen.add(id);
        records.push({ id, key: text(e.key), time, content: text(e.content, 2048), level: text(e.level) });
    }
    const total = numeric(r.totalRows);
    const countKnown = total !== undefined && Number.isSafeInteger(total) && total >= records.length;
    return {
        records,
        ...(countKnown ? { totalRows: total } : {}),
        truncated: r.scanTruncated === true || (countKnown && total > r.data.length),
        completenessKnown: countKnown,
        invalidRecords: invalid,
        complete: countKnown && total <= r.data.length && r.scanTruncated !== true && invalid === 0,
    };
}
function safeVlan(v: unknown) {
    const r = object(v);
    return {
        scope: text(r.scope),
        override: fields(object(r.override), ['status', 'enabled']),
        inherited: fields(object(r.inherited), ['status', 'mode', 'vlanId', 'vlanPoolIds', 'reason']),
        effective: fields(object(r.effective), ['status', 'mode', 'vlanId', 'vlanPoolIds', 'source', 'reason']),
    };
}

export class NetworkDiagnosisOperations {
    constructor(
        private readonly client: NetworkDiagnosisClient,
        private readonly site: SiteOperations
    ) {}
    private async read<T>(
        source: string,
        fn: () => Promise<unknown>,
        project: (value: unknown) => T,
        complete: (data: T) => boolean = () => true
    ): Promise<Evidence<T>> {
        try {
            const data = project(await fn());
            return { source, collectedAt: Date.now(), status: complete(data) ? 'ok' : 'partial', data };
        } catch (error) {
            const e = obj(error),
                response = obj(e?.response);
            const status = e?.status ?? response?.status;
            const state =
                error instanceof TypeError
                    ? 'unknown'
                    : status === 401 || status === 403
                      ? 'forbidden'
                      : [404, 405, 501].includes(Number(status))
                        ? 'unsupported'
                        : 'unavailable';
            return {
                source,
                collectedAt: Date.now(),
                status: state,
                reason: 'Requested evidence could not be established; other sections remain available.',
                ...(typeof status === 'number' && Number.isSafeInteger(status) ? { httpStatus: status } : {}),
            };
        }
    }
    async diagnoseNetwork(options: NetworkDiagnosisOptions = {}) {
        const input = networkDiagnosisOptionsSchema.parse(options),
            siteId = this.site.resolveSiteId(input.siteId),
            capturedAt = Date.now();
        const logStart = capturedAt - input.hours * 3600_000,
            end = Math.floor(capturedAt / 1000),
            start = end - 3600;
        const [devices, clients, wifi, switchPorts, topology, events, alerts, rfPlanning] = await Promise.all([
            this.read(
                'listDevices',
                () => this.client.listDevices(siteId, { maxRecords: 1000 }),
                (v) => inventory(v)
            ),
            this.read(
                'listClients',
                () => this.client.listClients(siteId, { maxRecords: 1000 }),
                (v) => inventory(v, true)
            ),
            this.read(
                'diagnoseWifi',
                () => this.client.diagnoseWifi({ siteId, maxAps: input.maxAps }),
                (v) =>
                    fields(object(v), [
                        'capturedAt',
                        'completedAt',
                        'collectionComplete',
                        'inventory',
                        'dashboard',
                        'aps',
                        'observations',
                        'limitations',
                    ]),
                (v) => v.collectionComplete === true
            ),
            this.read(
                'getSwitchPortOverview',
                () => this.client.getSwitchPortOverview(undefined, siteId),
                (v) => {
                    const r = object(v);
                    if (!Array.isArray(r.ports) || !Array.isArray(r.switches)) throw new TypeError('Unusable port overview');
                    return {
                        ...fields(r, ['inventoryStatus', 'inventoryTruncated', 'collectionComplete', 'switches', 'limitations']),
                        collectionComplete: r.collectionComplete === true,
                        ports: r.ports.slice(0, 512),
                        portsTruncated: r.ports.length > 512,
                    };
                },
                (v) => v.collectionComplete === true && !v.portsTruncated
            ),
            this.read(
                'getSiteTopology',
                () => this.client.getSiteTopology(siteId),
                (v) => {
                    const r = object(v),
                        time = numeric(r.lastUpdateTime);
                    if (!Array.isArray(r.topologyArray)) throw new TypeError('Unusable topology');
                    const qualified = time !== undefined && Number.isSafeInteger(time) && time >= 1_000_000_000_000 && time <= capturedAt + 60_000;
                    return {
                        rootCount: r.topologyArray.length,
                        ...(qualified ? { updatedAt: time } : {}),
                        freshness: qualified ? (capturedAt - time > 600_000 ? 'stale' : 'fresh') : 'unknown',
                        staleAfterMs: 600_000,
                    };
                },
                (v) => v.freshness === 'fresh'
            ),
            this.read(
                'listEvents excluding OSG_',
                () => this.client.listEvents(siteId, 1, 200, logStart, capturedAt, undefined, undefined, 'OSG_', { maxPages: 4 }),
                (v) => grid(v, 200, logStart, capturedAt),
                (v) => v.complete
            ),
            this.read(
                'listAlerts',
                () => this.client.listAlerts(siteId, 1, 200, logStart, capturedAt),
                (v) => grid(v, 200, logStart, capturedAt),
                (v) => v.complete
            ),
            this.read(
                'getRfPlanningStatus',
                () => this.client.getRfPlanningStatus({ siteId }),
                (v) => fields(object(v), ['readOnly', 'collectionComplete', 'sections', 'limitations']),
                (v) => v.collectionComplete === true
            ),
        ]);
        const deviceRows = 'data' in devices ? devices.data : [];
        const gateways = deviceRows.filter((d) => d.type === 'gateway'),
            aps = deviceRows.filter((d) => d.type === 'ap');
        const [wan, vlans] = await Promise.all([
            this.read(
                'diagnoseWan per managed gateway',
                async () =>
                    Promise.all(
                        gateways.slice(0, 4).map(async (g) => ({
                            gatewayMac: g.mac,
                            report: await this.read(
                                'diagnoseWan',
                                () => this.client.diagnoseWan({ siteId, gatewayMac: String(g.mac), start, end, maxSamples: 72 }),
                                (v) => fields(object(v), ['capturedAt', 'completedAt', 'queryWindow', 'collectionComplete', 'sections', 'notes']),
                                (v) => v.collectionComplete === true
                            ),
                        }))
                    ),
                (v) => {
                    if (!Array.isArray(v)) throw new TypeError('Unusable WAN collection');
                    return {
                        gateways: v.map((x) => ({
                            gatewayMac: x.gatewayMac,
                            ...('data' in x.report ? { report: x.report.data } : { errorState: x.report.status }),
                        })),
                        sourceComplete: v.every((x) => x.report.status === 'ok'),
                        truncated: gateways.length > 4,
                        inventoryKnown: devices.status === 'ok',
                    };
                },
                (v) => v.sourceComplete && !v.truncated && v.inventoryKnown
            ),
            this.read(
                'getApSsidOverrides per managed AP',
                async () =>
                    Promise.all(
                        aps.slice(0, input.maxAps).map(async (ap) => ({
                            apMac: ap.mac,
                            result: await this.read(
                                'getApSsidOverrides',
                                () => this.client.getApSsidOverrides(String(ap.mac), siteId),
                                (v) => {
                                    const r = object(v);
                                    if (!Array.isArray(r.ssidOverrides) || r.ssidOverrides.length > 256)
                                        throw new TypeError('Unusable SSID inventory');
                                    return {
                                        apMac: ap.mac,
                                        ssidOverrides: r.ssidOverrides.map((e) => {
                                            const s = object(e);
                                            return { ssidId: text(s.ssidId), ssidName: text(s.ssidName), vlan: safeVlan(s.vlan) };
                                        }),
                                    };
                                },
                                (v) => v.ssidOverrides.every((s) => s.vlan.effective.status === 'resolved')
                            ),
                        }))
                    ),
                (v) => {
                    if (!Array.isArray(v)) throw new TypeError('Unusable VLAN collection');
                    return {
                        aps: v.map((x) => ({
                            apMac: x.apMac,
                            ...('data' in x.result ? { report: x.result.data } : { errorState: x.result.status }),
                        })),
                        sourceComplete: v.every((x) => x.result.status === 'ok'),
                        truncated: aps.length > input.maxAps,
                        inventoryKnown: devices.status === 'ok',
                    };
                },
                (v) => v.sourceComplete && !v.truncated && v.inventoryKnown
            ),
        ]);
        const sections = { devices, clients, wifi, switchPorts, topology, events, alerts, rfPlanning, wan, vlans };
        const all = networkFindings(sections, input.weakRssiDbm);
        const clientRows = 'data' in clients ? clients.data : [];
        return {
            siteId,
            capturedAt,
            completedAt: Date.now(),
            readOnly: true,
            queryWindows: { logs: { start: logStart, end: capturedAt, unit: 'milliseconds' }, telemetry: { start, end, unit: 'seconds' } },
            policy: {
                weakRssiDbm: input.weakRssiDbm,
                maxAps: input.maxAps,
                maxDevices: 1000,
                maxClients: 1000,
                maxObservations: 100,
                maxFilteredEventPages: 4,
            },
            collectionComplete:
                Object.values(sections).every((s) => s.status === 'ok') && all.length <= 100 && !all.some((o) => o.basis === 'evidence_gap'),
            summary: {
                managedDevices: devices.status === 'ok' ? deviceRows.length : null,
                connectedDevices: devices.status === 'ok' ? deviceRows.filter((d) => d.status === 1).length : null,
                deviceStatesUnknown: devices.status === 'ok' ? deviceRows.filter((d) => d.status === undefined).length : null,
                clients: clients.status === 'ok' ? clientRows.length : null,
                wirelessClients: clients.status === 'ok' ? clientRows.filter((c) => c.wireless === true).length : null,
                clientHealthScoresUnavailable: clients.status === 'ok' ? clientRows.filter((c) => c.healthScore === null).length : null,
            },
            observations: all.slice(0, 100),
            observationsAvailable: all.length,
            observationsTruncated: all.length > 100,
            sections,
            limitations: [
                'Evidence review only: no health score, proven root cause, failover test, scan or configuration change.',
                'Reads are independent and may be cached; controller snapshots do not prove physical coverage, cable paths or current client performance.',
                'RSSI review uses an explicit policy threshold. Candidate channel overlap does not prove mutual radio visibility or harmful contention.',
                'Channel overlap detection covers qualified standard 5 GHz 20/40/80 MHz blocks and the lower two 160 MHz blocks; no 6 GHz overlap is inferred.',
                'Log recovery is correlated only for recognized switch/port identities with a later matching clear event in the returned window. Missing recovery evidence does not prove an active loop.',
                'Bounded sources can be partial. Empty findings never establish absence of faults. Dynamic VLAN assignment, packet delivery and firewall isolation are outside this report.',
            ],
        };
    }
}
