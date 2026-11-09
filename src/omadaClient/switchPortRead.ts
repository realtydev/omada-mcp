import type { OmadaApiResponse, OmadaDeviceInfo } from '../types/index.js';
import { normalizeMac, portNumber, record, validateSwitchMac } from '../utils/switch-port-safety.js';
import type { DeviceOperations } from './device.js';
import type { InternalRequestHandler } from './internalRequest.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';
import type { SwitchOperations } from './switch.js';

type Row = Record<string, unknown>;
type EvidenceState = 'ok' | 'forbidden' | 'unsupported' | 'unavailable' | 'unknown';
interface ReadEvidence {
    status: EvidenceState;
    source: string;
    value?: Row;
}
export interface SwitchPortCoverage {
    switchMac: string;
    switchName?: string;
    status: 'complete' | 'partial' | 'unavailable';
    inventoryKnown: boolean;
    knownPorts: number;
    telemetryPorts: number;
    sources: { configuration: EvidenceState; internal: EvidenceState; poe: EvidenceState };
}
export interface SwitchPortOverview {
    capturedAt: number;
    completedAt: number;
    siteId: string;
    collectionComplete: boolean;
    inventoryStatus: EvidenceState;
    inventoryTruncated: boolean;
    switches: SwitchPortCoverage[];
    ports: Row[];
    limitations: string[];
}
const canonicalMac = (mac: string) => {
    validateSwitchMac(mac);
    return normalizeMac(mac).match(/.{2}/g)!.join('-').toUpperCase();
};
function state(error: unknown): EvidenceState {
    const e = record(error),
        response = record(e?.response);
    const status = e?.status ?? response?.status;
    if (status === 401 || status === 403 || [-44106, -44112, -44113].includes(Number(e?.errorCode))) return 'forbidden';
    if ([404, 405, 501].includes(Number(status)) || e?.errorCode === -1600) return 'unsupported';
    return typeof e?.code === 'string' || Number(status) >= 500 ? 'unavailable' : 'unknown';
}
function identity(value: Row): string {
    const port = portNumber(value.port);
    if (port === undefined) throw new Error('Invalid physical port');
    const standard = record(value.standardPort ?? value.oswStandPort);
    if (standard && portNumber(standard.port) !== port) throw new Error('Conflicting standard port');
    const unit = standard?.unit ?? 1,
        slot = standard?.slot ?? 0;
    if (!Number.isSafeInteger(unit) || Number(unit) < 1 || !Number.isSafeInteger(slot) || Number(slot) < 0)
        throw new Error('Invalid stack port identity');
    return `${unit}:${slot}:${port}`;
}
function indexed(value: unknown): Map<string, Row> {
    if (!Array.isArray(value) || value.length > 512) throw new Error('Invalid or oversized switch port inventory');
    const rows = new Map<string, Row>();
    for (const v of value) {
        const r = record(v);
        if (!r) throw new Error('Invalid switch port row');
        const key = identity(r);
        if (rows.has(key)) throw new Error('Duplicate physical port');
        rows.set(key, r);
    }
    return rows;
}
const select = (value: Row, keys: string[]) =>
    Object.fromEntries(
        keys
            .filter(
                (k) =>
                    typeof value[k] === 'boolean' ||
                    (typeof value[k] === 'number' && Number.isFinite(value[k])) ||
                    (typeof value[k] === 'string' && value[k].length <= 256)
            )
            .map((k) => [k, value[k]])
    );
function telemetry(value: unknown): Row | undefined {
    const r = record(value);
    if (!r || ![0, 1].includes(Number(r.linkStatus)) || typeof r.linkStatus !== 'number') return undefined;
    const out: Row = {};
    for (const k of ['port', 'linkStatus', 'linkSpeed', 'duplex', 'tx', 'rx', 'txRate', 'rxRate', 'poePower'])
        if (typeof r[k] === 'number' && Number.isFinite(r[k]) && Number(r[k]) >= 0) out[k] = r[k];
    for (const k of ['poe', 'stpDiscarding']) if (typeof r[k] === 'boolean') out[k] = r[k];
    for (const k of ['stp', 'chassisIdSubtype', 'chassisId', 'portIdSubtype', 'portId'])
        if (typeof r[k] === 'string' && r[k].length <= 256) out[k] = r[k];
    return out;
}
function speedMbps(raw: Row | undefined, code: unknown): number | undefined {
    if (!Array.isArray(raw?.portSpeedCap) || raw.portSpeedCap.length > 128) return undefined;
    const speeds = new Set<number>();
    for (const cap of raw.portSpeedCap) {
        const speed = record(record(cap)?.linkSpeed);
        if (!speed || speed.value !== code || typeof speed.name !== 'string') continue;
        const match = speed.name.match(/^(\d+(?:\.\d+)?)(M|G)$/);
        if (match) speeds.add(Number(match[1]) * (match[2] === 'G' ? 1000 : 1));
    }
    return speeds.size === 1 ? [...speeds][0] : undefined;
}

/** Read coverage is separate from the established mutation-preservation/safety readers. */
export class SwitchPortReadOperations {
    private internal?: InternalRequestHandler;
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string,
        private readonly inventory: Pick<DeviceOperations, 'listDevices'>,
        private readonly configuration: Pick<SwitchOperations, 'getSwitch'>
    ) {}
    setInternalRequest(request: InternalRequestHandler): void {
        this.internal = request;
    }
    private async evidence(source: string, read: () => Promise<unknown>): Promise<ReadEvidence> {
        try {
            const value = record(await read());
            if (!value) throw new Error('Invalid evidence');
            return { source, status: 'ok', value };
        } catch (error) {
            return { source, status: state(error) };
        }
    }
    async getSwitchPortOverview(switchMac?: string, siteId?: string): Promise<SwitchPortOverview> {
        const capturedAt = Date.now(),
            resolved = this.site.resolveSiteId(siteId),
            target = switchMac === undefined ? undefined : canonicalMac(switchMac);
        let devices: OmadaDeviceInfo[] = [],
            inventoryStatus: EvidenceState = 'ok',
            inventoryTruncated = false;
        const [inventory, poeResult] = await Promise.allSettled([
            this.inventory.listDevices(resolved, { maxRecords: 1000 }),
            this.request.fetchPaginated<Row>(this.buildPath(`/sites/${encodeURIComponent(resolved)}/switches/ports/poe-info`), {}, 200, {
                maxRecords: 8192,
            }),
        ]);
        if (inventory.status === 'fulfilled') devices = inventory.value.filter((d) => d.type === 'switch');
        else inventoryStatus = state(inventory.reason);
        const selected = new Map<string, { mac: string; name?: string }>();
        for (const d of devices) {
            try {
                const mac = canonicalMac(d.mac);
                if (selected.has(mac)) {
                    inventoryStatus = 'unknown';
                    continue;
                }
                selected.set(mac, { mac, name: d.name });
            } catch {
                inventoryStatus = 'unknown';
            }
        }
        if (target) {
            const known = selected.get(target);
            selected.clear();
            selected.set(target, known ?? { mac: target });
        }
        let poeState: EvidenceState = poeResult.status === 'fulfilled' ? 'ok' : state(poeResult.reason);
        const poe = new Map<string, Map<string, Row>>();
        if (poeResult.status === 'fulfilled')
            try {
                for (const r of poeResult.value) {
                    const mac = canonicalMac(String(r.switchMac));
                    const key = identity(r),
                        ports = poe.get(mac) ?? new Map<string, Row>();
                    if (ports.has(key) || ports.size >= 512) throw new Error('Invalid primary telemetry inventory');
                    ports.set(key, r);
                    poe.set(mac, ports);
                    if (!target && !selected.has(mac)) selected.set(mac, { mac });
                }
            } catch {
                poe.clear();
                poeState = 'unknown';
            }
        if (selected.size > 64) inventoryTruncated = true;
        const switches: SwitchPortCoverage[] = [],
            ports: Row[] = [];
        const targets = [...selected.values()].slice(0, 64);
        for (let offset = 0; offset < targets.length; offset += 4) {
            if (Date.now() - capturedAt > 30_000) {
                inventoryTruncated = true;
                for (const d of targets.slice(offset))
                    switches.push({
                        switchMac: d.mac,
                        switchName: d.name,
                        status: 'unavailable',
                        inventoryKnown: false,
                        knownPorts: 0,
                        telemetryPorts: 0,
                        sources: { configuration: 'unavailable', internal: 'unavailable', poe: poeState },
                    });
                break;
            }
            const results = await Promise.all(
                targets.slice(offset, offset + 4).map(async (d) => {
                    const [config, web] = await Promise.all([
                        this.evidence('open-api-switch-detail', () => this.configuration.getSwitch(d.mac, resolved)),
                        this.internal
                            ? this.evidence('internal-web-api', async () =>
                                  this.internal!.ensureSuccess(
                                      await this.internal!.get<OmadaApiResponse<unknown>>(
                                          `/sites/${encodeURIComponent(resolved)}/switches/${encodeURIComponent(d.mac)}`
                                      )
                                  )
                              )
                            : Promise.resolve({ source: 'internal-web-api', status: 'unavailable' } as ReadEvidence),
                    ]);
                    const sources = { configuration: config.status, internal: web.status, poe: poeState };
                    let publicPorts: Map<string, Row> | undefined, webPorts: Map<string, Row> | undefined;
                    for (const [e, key] of [
                        [config, 'portList'],
                        [web, 'ports'],
                    ] as const) {
                        if (e.status !== 'ok') continue;
                        try {
                            if (typeof e.value?.mac !== 'string' || canonicalMac(e.value.mac) !== d.mac)
                                throw new Error('Mismatched switch evidence');
                            const rows = indexed(e.value[key]);
                            if (key === 'portList') publicPorts = rows;
                            else webPorts = rows;
                        } catch {
                            e.status = 'unknown';
                            if (key === 'portList') sources.configuration = 'unknown';
                            else sources.internal = 'unknown';
                        }
                    }
                    const primary = poe.get(d.mac) ?? new Map<string, Row>();
                    const keys = new Set([...(publicPorts?.keys() ?? []), ...(webPorts?.keys() ?? []), ...primary.keys()]);
                    const consistent =
                        !publicPorts || !webPorts || JSON.stringify([...publicPorts.keys()].sort()) === JSON.stringify([...webPorts.keys()].sort());
                    const authority = publicPorts ?? webPorts;
                    const inventoryKnown =
                        consistent && authority !== undefined && authority.size > 0 && [...primary.keys()].every((k) => authority.has(k));
                    const result: Row[] = [];
                    let telemetryPorts = 0;
                    for (const key of keys) {
                        const c = publicPorts?.get(key),
                            w = webPorts?.get(key),
                            p = primary.get(key);
                        let current = telemetry(p?.portStatus) ?? telemetry(w?.portStatus);
                        if (current?.port !== undefined && current.port !== (p ?? w ?? c)!.port) current = undefined;
                        const telemetrySource = current ? (telemetry(p?.portStatus) ? 'open-api-poe-info' : 'internal-web-api') : 'unavailable';
                        if (current) telemetryPorts++;
                        const base = p
                            ? select(p, [
                                  'switchMac',
                                  'switchName',
                                  'port',
                                  'portName',
                                  'oswStandPort',
                                  'supportPoe',
                                  'configStack',
                                  'configMlagPeerLink',
                                  'configMlagDad',
                                  'disable',
                                  'linkSpeed',
                                  'duplex',
                                  'power',
                                  'voltage',
                                  'current',
                                  'type',
                                  'operation',
                                  'connectedStatus',
                                  'switchStatusCategory',
                                  'switchSupportPoe',
                                  'site',
                                  'poeDisplayType',
                                  'poe',
                                  'pdClass',
                              ])
                            : {};
                        const configured = {
                            ...(c ? select(c, ['name', 'profileId', 'profileName', 'profileOverrideEnable', 'poeMode', 'lagPort', 'status']) : {}),
                            ...(w
                                ? select(w, [
                                      'name',
                                      'disable',
                                      'profileId',
                                      'profileName',
                                      'profileOverrideEnable',
                                      'configStack',
                                      'configMlagPeerLink',
                                      'configMlagDad',
                                  ])
                                : {}),
                        };
                        const up = current?.linkStatus === 1;
                        const mbps = up ? speedMbps(w, current?.linkSpeed) : undefined;
                        result.push({
                            ...base,
                            ...(p?.oswStandPort
                                ? {
                                      oswStandPort: {
                                          unit: Number(key.split(':')[0]),
                                          slot: Number(key.split(':')[1]),
                                          port: Number((p ?? w ?? c)!.port),
                                      },
                                  }
                                : {}),
                            ...(Array.isArray(p?.tagIds) && p.tagIds.length <= 64 && p.tagIds.every((v) => typeof v === 'string' && v.length <= 256)
                                ? { tagIds: p.tagIds }
                                : {}),
                            switchMac: d.mac,
                            switchName: d.name ?? base.switchName,
                            port: Number((p ?? w ?? c)!.port),
                            portName: base.portName ?? select(w ?? {}, ['name']).name ?? select(c ?? {}, ['name']).name,
                            standardPort: { unit: Number(key.split(':')[0]), slot: Number(key.split(':')[1]), port: Number((p ?? w ?? c)!.port) },
                            configured,
                            ...(current ? { portStatus: current } : {}),
                            operational: {
                                status: current ? 'available' : 'unavailable',
                                source: telemetrySource,
                                ...(current
                                    ? {
                                          linkUp: up,
                                          linkSpeedCode: current.linkSpeed,
                                          duplex: current.duplex === 2 ? 'full' : current.duplex === 1 ? 'half' : 'unknown',
                                      }
                                    : {}),
                                ...(mbps !== undefined ? { negotiatedSpeedMbps: mbps } : {}),
                            },
                            evidence: { configurationSource: c ? 'open-api-switch-detail' : w ? 'internal-web-api' : 'unavailable', telemetrySource },
                        });
                    }
                    const complete = inventoryKnown && keys.size > 0 && telemetryPorts === keys.size;
                    return {
                        coverage: {
                            switchMac: d.mac,
                            switchName: d.name,
                            status: complete ? 'complete' : keys.size ? 'partial' : 'unavailable',
                            inventoryKnown,
                            knownPorts: keys.size,
                            telemetryPorts,
                            sources,
                        } as SwitchPortCoverage,
                        ports: result,
                    };
                })
            );
            for (const r of results) {
                switches.push(r.coverage);
                ports.push(...r.ports);
            }
        }
        return {
            capturedAt,
            completedAt: Date.now(),
            siteId: resolved,
            inventoryStatus,
            inventoryTruncated,
            collectionComplete:
                inventoryStatus === 'ok' && !inventoryTruncated && poeState !== 'unknown' && switches.every((s) => s.status === 'complete'),
            switches,
            ports,
            limitations: [
                'Managed-switch ports only; gateway-integrated and unmanaged ports are outside this inventory.',
                'Configuration/admin status is separate from live link state. Down links have no negotiated Mbps value.',
                'Speed conversion uses controller-provided port capability labels; unknown codes remain unconverted.',
                'Reads are not atomic. Freshness of controller telemetry is unknown; retrieved data may be cached.',
                'Bounded to 1000 inventory devices, 64 switches, 512 ports per source/switch and a 30-second start budget; in-flight reads retain client timeouts.',
            ],
        };
    }
    async listSwitchPorts(switchMac?: string, siteId?: string): Promise<Row[]> {
        const report = await this.getSwitchPortOverview(switchMac, siteId);
        if (report.inventoryStatus !== 'ok' || report.inventoryTruncated || report.switches.some((s) => !s.inventoryKnown))
            throw new Error('Switch port inventory is incomplete. Use getSwitchPortOverview for explicit coverage and partial evidence.');
        return report.ports;
    }
}
