import { normalizeMac, portNumber, record, validateSwitchMac } from '../utils/switch-port-safety.js';

export const POE_SOURCE = 'dashboard-poe-usage';
export const MAX_POE_SWITCHES = 50;
export const MAX_POE_PORTS = 512;
export interface PoePortUsage extends Record<string, unknown> {
    portId: number;
    source: typeof POE_SOURCE;
    status: 'complete' | 'partial' | 'unsupported';
    missingFields: string[];
    poeSupported?: boolean;
    poeEnabled?: boolean;
    poePower?: number;
    poePercent?: number;
}
export interface PoeSwitchUsage extends Record<string, unknown> {
    mac: string;
    source: typeof POE_SOURCE;
    status: 'complete' | 'partial' | 'unsupported';
    missingFields: string[];
    poePorts: PoePortUsage[];
    truncated: boolean;
}
const numeric = (value: unknown, percent = false): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!percent || value <= 100);

/** Dashboard PoE rows are power evidence, never authority for a physical port inventory. */
export function parsePoeUsage(value: unknown): { switches: PoeSwitchUsage[]; truncated: boolean; partial: boolean } {
    if (!Array.isArray(value)) throw new Error('Controller did not return a PoE device list.');
    const seen = new Set<string>();
    const switches = value.slice(0, MAX_POE_SWITCHES).map((item): PoeSwitchUsage => {
        const row = record(item);
        if (!row || !Object.hasOwn(row, 'mac') || typeof row.mac !== 'string')
            throw new Error('Controller returned PoE data without a switch identity.');
        validateSwitchMac(row.mac);
        const mac = normalizeMac(row.mac).match(/.{2}/g)!.join('-').toUpperCase();
        if (seen.has(mac)) throw new Error('Controller returned duplicate PoE switch identities.');
        seen.add(mac);
        const missingFields: string[] = [];
        const duplicates = new Set<number>();
        const ids = new Set<number>();
        const rawPorts = Array.isArray(row.poePorts) ? row.poePorts : [];
        if (!Array.isArray(row.poePorts) || row.poePorts.length === 0) missingFields.push('poePorts');
        const ports = rawPorts.slice(0, MAX_POE_PORTS).flatMap((item): PoePortUsage[] => {
            const raw = record(item);
            const portId = raw && Object.hasOwn(raw, 'portId') && typeof raw.portId === 'number' ? portNumber(raw.portId) : undefined;
            if (!raw || portId === undefined) {
                missingFields.push('invalid_port_identity');
                return [];
            }
            if (ids.has(portId)) duplicates.add(portId);
            ids.add(portId);
            const fields: string[] = [];
            const port: PoePortUsage = { portId, source: POE_SOURCE, status: 'complete', missingFields: fields };
            for (const key of ['poeSupported', 'poeEnabled'] as const) {
                if (Object.hasOwn(raw, key) && typeof raw[key] === 'boolean') port[key] = raw[key];
                else fields.push(key);
            }
            if (port.poeSupported === false) {
                port.status = 'unsupported';
                return [port];
            }
            for (const key of ['poePower', 'poePercent'] as const) {
                if (Object.hasOwn(raw, key) && numeric(raw[key], key === 'poePercent')) port[key] = raw[key];
                else fields.push(key);
            }
            if (fields.length) port.status = 'partial';
            return [port];
        });
        if (duplicates.size) missingFields.push('duplicate_port_identity');
        const poePorts = ports.filter((port) => !duplicates.has(port.portId));
        const unsupported =
            rawPorts.length > 0 &&
            rawPorts.length <= MAX_POE_PORTS &&
            rawPorts.every((port) => {
                const raw = record(port);
                return raw && Object.hasOwn(raw, 'poeSupported') && raw.poeSupported === false;
            });
        const result: PoeSwitchUsage = {
            mac,
            source: POE_SOURCE,
            status: unsupported ? 'unsupported' : 'complete',
            missingFields: [...new Set(missingFields)],
            poePorts,
            truncated: rawPorts.length > MAX_POE_PORTS,
        };
        if (Object.hasOwn(row, 'name') && typeof row.name === 'string' && row.name.length <= 256) result.name = row.name;
        if (Object.hasOwn(row, 'portNum') && Number.isSafeInteger(row.portNum) && Number(row.portNum) >= 0) result.portNum = row.portNum;
        else result.missingFields.push('portNum');
        if (unsupported) result.supported = false;
        else {
            for (const key of ['totalPower', 'totalPowerUsed', 'totalPercentUsed']) {
                if (Object.hasOwn(row, key) && numeric(row[key], key === 'totalPercentUsed')) result[key] = row[key];
                else result.missingFields.push(key);
            }
            if (numeric(result.totalPower) && result.totalPower > 0 && numeric(result.totalPowerUsed))
                result.headroomWatts = result.totalPower - result.totalPowerUsed;
            else result.missingFields.push('headroomWatts');
        }
        if (result.missingFields.length || result.truncated || poePorts.some((port) => port.status === 'partial')) result.status = 'partial';
        return result;
    });
    return {
        switches,
        truncated: value.length > MAX_POE_SWITCHES || switches.some((item) => item.truncated),
        partial: value.length > MAX_POE_SWITCHES || switches.some((item) => item.status === 'partial'),
    };
}
