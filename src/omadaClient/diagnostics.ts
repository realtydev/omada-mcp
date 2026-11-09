import type { ClientHistory, GetClientHistoryOptions, OmadaClientInfo, OmadaDeviceInfo, PaginatedResult } from '../types/index.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TOPOLOGY_NODES = 2000;
const MAX_TOPOLOGY_DEPTH = 64;
const TOPOLOGY_STALE_AFTER_MS = 10 * 60 * 1000;

export interface DiagnosticsClient {
    listClients(siteId?: string): Promise<OmadaClientInfo[]>;
    listDevices(siteId?: string): Promise<OmadaDeviceInfo[]>;
    getSiteTopology(siteId?: string): Promise<unknown>;
    getClientHistory(options: GetClientHistoryOptions): Promise<ClientHistory>;
    listEvents(
        siteId?: string,
        page?: number,
        pageSize?: number,
        timeStart?: number,
        timeEnd?: number
    ): Promise<PaginatedResult<unknown> & { scanTruncated?: boolean }>;
    listAlerts(siteId?: string, page?: number, pageSize?: number, timeStart?: number, timeEnd?: number): Promise<PaginatedResult<unknown>>;
}

export type DiagnosticSection<T> = { status: 'ok'; data: T } | { status: 'error' | 'not_found'; message: string };

export interface DiagnosticQueryWindow {
    timeStart: number;
    timeEnd: number;
}

export interface DiagnosticPathNode {
    source: 'client_attachment' | 'controller_topology';
    mac?: string;
    name?: string;
    type?: string | number;
    model?: string;
    status?: unknown;
    wireUpLink?: unknown;
}

export interface ClientPathEvidence {
    direction: 'client_to_root';
    scope: 'controller_discovery';
    nodes: DiagnosticPathNode[];
    topologyUpdatedAt?: number;
    staleness: 'fresh' | 'stale' | 'unknown';
    staleAfterMs: number;
    traversalTruncated: boolean;
    message: string;
}

interface TopologyScan {
    path?: Record<string, unknown>[];
    visited: number;
    truncated: boolean;
    rootCount: number;
    updatedAt?: number;
    staleness: ClientPathEvidence['staleness'];
}

export interface DiagnoseClientResult {
    clientMac: string;
    capturedAt: number;
    queryWindow: DiagnosticQueryWindow;
    collectionComplete: boolean;
    pathComplete: boolean;
    path: ClientPathEvidence;
    sections: {
        client: DiagnosticSection<OmadaClientInfo>;
        devices: DiagnosticSection<OmadaDeviceInfo[]>;
        topology: DiagnosticSection<{ rootCount: number; nodesVisited: number; traversalTruncated: boolean; updatedAt?: number }>;
        history: DiagnosticSection<ClientHistory>;
    };
}

export interface LogDiagnosticData {
    data: unknown[];
    totalRows?: number;
    currentPage: number;
    pageSize: number;
    truncated: boolean;
    completenessKnown: boolean;
}

export interface DiagnoseLogsResult {
    capturedAt: number;
    queryWindow: DiagnosticQueryWindow;
    collectionComplete: boolean;
    sections: { events: DiagnosticSection<LogDiagnosticData>; alerts: DiagnosticSection<LogDiagnosticData> };
}

const normalizeMac = (mac: string): string => mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const errorMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

function queryWindow(timeStart: number | undefined, timeEnd: number | undefined, capturedAt: number): DiagnosticQueryWindow {
    const end = timeEnd ?? capturedAt;
    const start = timeStart ?? end - DEFAULT_WINDOW_MS;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0 || start > end) {
        throw new Error('timeStart and timeEnd must be non-negative epoch milliseconds with timeStart <= timeEnd.');
    }
    return { timeStart: start, timeEnd: end };
}

function section<T>(result: PromiseSettledResult<T>): DiagnosticSection<T> {
    return result.status === 'fulfilled' ? { status: 'ok', data: result.value } : { status: 'error', message: errorMessage(result.reason) };
}

function scanTopology(topology: unknown, attachmentMac: string | undefined, capturedAt: number): TopologyScan {
    const tree = record(topology);
    if (!tree || !Array.isArray(tree.topologyArray)) {
        throw new Error('The controller topology response does not contain topologyArray.');
    }
    const time = typeof tree.lastUpdateTime === 'number' && Number.isFinite(tree.lastUpdateTime) ? tree.lastUpdateTime : undefined;
    const updatedAt = time === undefined ? undefined : time < 1_000_000_000_000 ? time * 1000 : time;
    const staleness =
        updatedAt === undefined ? 'unknown' : capturedAt - updatedAt > TOPOLOGY_STALE_AFTER_MS || updatedAt > capturedAt + 60_000 ? 'stale' : 'fresh';
    const roots = tree.topologyArray;
    const stack = roots
        .slice(0, MAX_TOPOLOGY_NODES)
        .reverse()
        .map((node: unknown) => ({ node, path: [] as Record<string, unknown>[] }));
    const visited = new Set<object>();
    let truncated = roots.length > MAX_TOPOLOGY_NODES;
    let match: Record<string, unknown>[] | undefined;
    let processed = 0;
    const wantedMac = attachmentMac === undefined ? undefined : normalizeMac(attachmentMac);
    while (stack.length > 0) {
        if (processed >= MAX_TOPOLOGY_NODES) {
            truncated = true;
            break;
        }
        processed += 1;
        const entry = stack.pop();
        if (!entry) break;
        const node = record(entry.node);
        if (!node) continue;
        if (visited.has(node)) {
            truncated = true;
            continue;
        }
        visited.add(node);
        const path = [...entry.path, node];
        if (wantedMac && typeof node.mac === 'string' && normalizeMac(node.mac) === wantedMac) {
            if (match) truncated = true;
            else match = path;
        }
        if (!Array.isArray(node.successors)) continue;
        if (path.length >= MAX_TOPOLOGY_DEPTH && node.successors.length > 0) {
            truncated = true;
            continue;
        }
        const capacity = Math.max(MAX_TOPOLOGY_NODES - processed - stack.length, 0);
        if (node.successors.length > capacity) truncated = true;
        for (const child of node.successors.slice(0, capacity).reverse()) {
            stack.push({ node: child, path });
        }
    }
    return { path: match, visited: visited.size, truncated, rootCount: roots.length, updatedAt, staleness };
}

function pathNode(node: Record<string, unknown>, inventory: OmadaDeviceInfo[]): DiagnosticPathNode {
    const device = typeof node.mac === 'string' ? inventory.find((item) => normalizeMac(item.mac) === normalizeMac(String(node.mac))) : undefined;
    return {
        source: 'controller_topology',
        ...(typeof node.mac === 'string' && { mac: node.mac }),
        ...(typeof node.name === 'string' && { name: node.name }),
        ...((typeof node.type === 'string' || typeof node.type === 'number') && { type: node.type }),
        ...(device?.model && { model: device.model }),
        ...(device?.status !== undefined && { status: device.status }),
        ...(node.wireUpLink !== undefined && { wireUpLink: node.wireUpLink }),
    };
}

function logSection(
    result: PromiseSettledResult<PaginatedResult<unknown> & { scanTruncated?: boolean }>,
    pageSize: number
): DiagnosticSection<LogDiagnosticData> {
    if (result.status === 'rejected') return { status: 'error', message: errorMessage(result.reason) };
    const value = result.value;
    if (!value || !Array.isArray(value.data)) return { status: 'error', message: 'The log response does not contain a data array.' };
    const data = value.data;
    const totalRows = typeof value.totalRows === 'number' && Number.isFinite(value.totalRows) && value.totalRows >= 0 ? value.totalRows : undefined;
    const completenessKnown = totalRows !== undefined || data.length < pageSize;
    const truncated = value.scanTruncated === true || (totalRows !== undefined ? totalRows > data.length : data.length >= pageSize);
    return { status: 'ok', data: { data, totalRows: value.totalRows, currentPage: 1, pageSize, truncated, completenessKnown } };
}

/** Composes existing read operations and preserves partial failures as evidence. */
export class DiagnosticsOperations {
    constructor(private readonly client: DiagnosticsClient) {}

    public async diagnoseClient(clientMac: string, siteId?: string, timeStart?: number, timeEnd?: number): Promise<DiagnoseClientResult> {
        if (!/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})$/i.test(clientMac)) {
            throw new Error('clientMac must be a full MAC address.');
        }
        const capturedAt = Date.now();
        const window = queryWindow(timeStart, timeEnd, capturedAt);
        const [clientsResult, devicesResult, topologyResult, historyResult] = await Promise.allSettled([
            this.client.listClients(siteId),
            this.client.listDevices(siteId),
            this.client.getSiteTopology(siteId),
            this.client.getClientHistory({ clientMac, siteId, ...window, roamTimeline: true }),
        ]);
        const currentClient =
            clientsResult.status === 'fulfilled' ? clientsResult.value.find((item) => normalizeMac(item.mac) === normalizeMac(clientMac)) : undefined;
        const client: DiagnosticSection<OmadaClientInfo> =
            clientsResult.status === 'rejected'
                ? { status: 'error', message: errorMessage(clientsResult.reason) }
                : currentClient
                  ? { status: 'ok', data: currentClient }
                  : { status: 'not_found', message: 'The exact client MAC is absent from the current client list; it may be disconnected.' };
        const devices = section(devicesResult);
        const history = section(historyResult);
        const attachmentKeys =
            currentClient?.connectDevType === 'ap' || currentClient?.wireless === true
                ? ['apMac']
                : currentClient?.connectDevType === 'gateway'
                  ? ['gatewayMac']
                  : currentClient?.connectDevType === 'switch'
                    ? ['switchMac']
                    : ['switchMac', 'gatewayMac', 'apMac'];
        const attachment =
            currentClient &&
            attachmentKeys
                .map((key) => currentClient[key])
                .find((value): value is string => typeof value === 'string' && normalizeMac(value).length === 12);
        let topology: DiagnoseClientResult['sections']['topology'];
        let scan: TopologyScan | undefined;
        if (topologyResult.status === 'rejected') {
            topology = { status: 'error', message: errorMessage(topologyResult.reason) };
        } else {
            try {
                scan = scanTopology(topologyResult.value, attachment, capturedAt);
                topology = {
                    status: 'ok',
                    data: { rootCount: scan.rootCount, nodesVisited: scan.visited, traversalTruncated: scan.truncated, updatedAt: scan.updatedAt },
                };
            } catch (error) {
                topology = { status: 'error', message: errorMessage(error) };
            }
        }
        const nodes = scan?.path
            ? scan.path
                  .slice()
                  .reverse()
                  .map((node) => pathNode(node, devices.status === 'ok' ? devices.data : []))
            : [];
        if (currentClient && nodes.length > 0) {
            nodes.unshift({
                source: 'client_attachment',
                mac: currentClient.mac,
                name: currentClient.name ?? currentClient.hostName,
                type: currentClient.wireless === true ? 'wireless_client' : 'client',
                ...(currentClient.port !== undefined && { wireUpLink: { upLinkPort: currentClient.port } }),
            });
        }
        const pathComplete = nodes.length > 0 && scan?.staleness === 'fresh' && !scan.truncated;
        const path: ClientPathEvidence = {
            direction: 'client_to_root',
            scope: 'controller_discovery',
            nodes,
            topologyUpdatedAt: scan?.updatedAt,
            staleness: scan?.staleness ?? 'unknown',
            staleAfterMs: TOPOLOGY_STALE_AFTER_MS,
            traversalTruncated: scan?.truncated ?? false,
            message:
                nodes.length === 0
                    ? 'No controller-discovered attachment path is available for this client.'
                    : 'Controller-discovered relationships only; unmanaged links may be missing. Check topology staleness before relying on this path.',
        };
        return {
            clientMac,
            capturedAt,
            queryWindow: window,
            pathComplete,
            path,
            collectionComplete:
                client.status === 'ok' &&
                devices.status === 'ok' &&
                topology.status === 'ok' &&
                history.status === 'ok' &&
                !history.data.truncated &&
                !scan?.truncated,
            sections: { client, devices, topology, history },
        };
    }

    public async diagnoseLogs(siteId?: string, timeStart?: number, timeEnd?: number, pageSize = 100): Promise<DiagnoseLogsResult> {
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('pageSize must be an integer between 1 and 200.');
        const capturedAt = Date.now();
        const window = queryWindow(timeStart, timeEnd, capturedAt);
        const [eventsResult, alertsResult] = await Promise.allSettled([
            this.client.listEvents(siteId, 1, pageSize, window.timeStart, window.timeEnd),
            this.client.listAlerts(siteId, 1, pageSize, window.timeStart, window.timeEnd),
        ]);
        const events = logSection(eventsResult, pageSize);
        const alerts = logSection(alertsResult, pageSize);
        return {
            capturedAt,
            queryWindow: window,
            collectionComplete:
                events.status === 'ok' &&
                alerts.status === 'ok' &&
                !events.data.truncated &&
                !alerts.data.truncated &&
                events.data.completenessKnown &&
                alerts.data.completenessKnown,
            sections: { events, alerts },
        };
    }
}
