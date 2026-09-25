import type {
    ActiveClientInfo,
    ClientActivity,
    ClientHistory,
    ClientPastConnection,
    ClientRoam,
    ClientSession,
    GetClientActivityOptions,
    GetClientHistoryOptions,
    ListClientsPastConnectionsOptions,
    OmadaApiResponse,
    OmadaClientInfo,
    PaginatedResult,
} from '../types/index.js';

import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

const HISTORY_PAGE_SIZE = 1000;
const HISTORY_MAX_PAGES = 20;
const DEFAULT_ROAM_MAX_GAP_SECONDS = 60;

const normaliseMac = (mac: string): string => mac.replace(/[^0-9a-f]/gi, '').toLowerCase();

/**
 * Client-related operations for the Omada API.
 */
export class ClientOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}

    /**
     * List all clients in a site.
     */
    public async listClients(siteId?: string): Promise<OmadaClientInfo[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        return await this.request.fetchPaginated<OmadaClientInfo>(this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients`));
    }

    /**
     * Get a specific client by MAC address or client ID.
     */
    public async getClient(identifier: string, siteId?: string): Promise<OmadaClientInfo | undefined> {
        const clients = await this.listClients(siteId);
        return clients.find((client) => client.mac === identifier || client.id === identifier);
    }

    /**
     * Get most active clients in a site (dashboard endpoint).
     * Returns clients sorted by total traffic.
     *
     * @param siteId - Optional site ID, uses default from config if not provided
     * @returns Array of active client information
     */
    public async listMostActiveClients(siteId?: string): Promise<ActiveClientInfo[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const response = await this.request.get<OmadaApiResponse<ActiveClientInfo[]>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/dashboard/active-clients`)
        );
        return response.result ?? [];
    }

    /**
     * Get client activity statistics over time (dashboard endpoint).
     * Returns time-series data about new, active, and disconnected clients.
     *
     * @param options - Options including optional siteId, start, and end timestamps
     * @returns Array of client activity snapshots over time
     */
    public async listClientsActivity(options: GetClientActivityOptions = {}): Promise<ClientActivity[]> {
        const resolvedSiteId = this.site.resolveSiteId(options.siteId);
        const params: Record<string, unknown> = {};

        if (options.start !== undefined) {
            params.start = options.start;
        }
        if (options.end !== undefined) {
            params.end = options.end;
        }

        const response = await this.request.get<OmadaApiResponse<ClientActivity[]>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/dashboard/client-activity`),
            params
        );
        return response.result ?? [];
    }

    /**
     * Get client past connection list (insight endpoint).
     * Returns historical client connection data with support for pagination, filtering, and sorting.
     *
     * @param options - Options including siteId, pagination, filters, and search parameters
     * @returns Array of client past connection information
     */
    public async listClientsPastConnections(options: ListClientsPastConnectionsOptions): Promise<ClientPastConnection[]> {
        const resolvedSiteId = this.site.resolveSiteId(options.siteId);
        const params: Record<string, unknown> = {
            page: options.page,
            pageSize: options.pageSize,
        };

        // Add optional sort parameter
        if (options.sortLastSeen !== undefined) {
            params['sorts.lastSeen'] = options.sortLastSeen;
        }

        // Add optional filter parameters
        if (options.timeStart !== undefined) {
            params['filters.timeStart'] = String(options.timeStart);
        }
        if (options.timeEnd !== undefined) {
            params['filters.timeEnd'] = String(options.timeEnd);
        }
        if (options.guest !== undefined) {
            params['filters.guest'] = String(options.guest);
        }

        // Add optional search parameter
        if (options.searchKey !== undefined) {
            params.searchKey = options.searchKey;
        }

        const response = await this.request.get<OmadaApiResponse<PaginatedResult<ClientPastConnection>>>(
            this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/insight/past-connection`),
            params
        );

        const result = this.request.ensureSuccess(response);
        return result.data ?? [];
    }
    /**
     * Get a client's association sessions over a time range, optionally with a roam timeline.
     *
     * Built on the insight `past-connection` endpoint rather than `/clients/{mac}/client-history`: on
     * controllers checked so far the latter ignores `page`, `pageSize` and the time filters and always
     * returns the 10 most recent sessions. Here `firstSeen` is the session start, `lastSeen` its end
     * and `duration` the length in seconds. `searchKey` is a fuzzy match, so results are re-filtered
     * to the exact MAC.
     */
    public async getClientHistory(options: GetClientHistoryOptions): Promise<ClientHistory> {
        const timeEnd = options.timeEnd ?? Date.now();
        const timeStart = options.timeStart ?? timeEnd - 7 * 24 * 60 * 60 * 1000;
        const wantedMac = normaliseMac(options.clientMac);

        const sessions: ClientSession[] = [];
        let truncated = false;
        for (let page = 1; ; page++) {
            const rows = await this.listClientsPastConnections({
                siteId: options.siteId,
                page,
                pageSize: HISTORY_PAGE_SIZE,
                sortLastSeen: 'desc',
                timeStart,
                timeEnd,
                searchKey: options.clientMac,
            });
            for (const row of rows) {
                if (row.mac !== undefined && normaliseMac(row.mac) === wantedMac && row.firstSeen !== undefined && row.lastSeen !== undefined) {
                    sessions.push({
                        start: row.firstSeen,
                        end: row.lastSeen,
                        durationSeconds: row.duration ?? Math.round((row.lastSeen - row.firstSeen) / 1000),
                        deviceName: row.deviceName,
                        ssid: row.ssid,
                        port: row.port,
                        associationTimeMs: row.associationTime,
                        download: row.download,
                        upload: row.upload,
                    });
                }
            }
            if (rows.length < HISTORY_PAGE_SIZE) {
                break;
            }
            if (page >= HISTORY_MAX_PAGES) {
                truncated = true;
                break;
            }
        }
        sessions.sort((a, b) => a.start - b.start);

        const history: ClientHistory = { clientMac: options.clientMac, sessions };
        if (options.roamTimeline) {
            history.roams = ClientOperations.findRoams(sessions, options.maxGapSeconds ?? DEFAULT_ROAM_MAX_GAP_SECONDS);
        }
        if (truncated) {
            history.truncated = true;
        }
        return history;
    }

    /**
     * A roam is two consecutive wireless sessions (sorted by start) on different devices where the
     * next session starts no more than `maxGapSeconds` after the previous one ended.
     */
    private static findRoams(sessions: ClientSession[], maxGapSeconds: number): ClientRoam[] {
        const roams: ClientRoam[] = [];
        for (let i = 1; i < sessions.length; i++) {
            const prev = sessions[i - 1];
            const next = sessions[i];
            const bothWireless = prev.ssid !== undefined && next.ssid !== undefined;
            const gapSeconds = (next.start - prev.end) / 1000;
            if (bothWireless && prev.deviceName !== next.deviceName && gapSeconds <= maxGapSeconds) {
                roams.push({
                    at: next.start,
                    from: { deviceName: prev.deviceName, ssid: prev.ssid, sessionEnd: prev.end },
                    to: { deviceName: next.deviceName, ssid: next.ssid, sessionStart: next.start },
                    gapSeconds,
                });
            }
        }
        return roams;
    }
}
