import type { OmadaApiResponse, PaginatedResult } from '../types/index.js';
import { logger } from '../utils/logger.js';

import type { InternalRequestHandler } from './internalRequest.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

/**
 * Network-related operations for the Omada API.
 * Covers internet, LAN, WLAN, firewall, and port forwarding configurations.
 */
export class NetworkOperations {
    private internalRequest?: InternalRequestHandler;

    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string, version?: string) => string
    ) {}

    /**
     * Set the internal request handler for web UI API access.
     * When configured, firewall ACL operations will use the internal API.
     */
    public setInternalRequest(internalRequest: InternalRequestHandler): void {
        this.internalRequest = internalRequest;
    }

    /**
     * Check whether the internal API is available for use.
     */
    private get hasInternalApi(): boolean {
        return this.internalRequest !== undefined;
    }

    /**
     * Get internet configuration info for a site.
     * OperationId: getInternet
     */
    public async getInternetInfo(siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/internet`);
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Get port forwarding status for a specific type (User or UPnP).
     *
     * For 'User' rules, uses the internal web UI API (`/setting/transmission/portForwardings`)
     * when web credentials are configured — confirmed by capturing the controller's own web UI
     * network traffic. When falling back to the public Open API's `insight/port-forwarding` path
     * (used always for 'UPnP', and for 'User' when no internal API is configured), the `type`
     * path segment must be lowercase (`user`/`upnp`) — the enum values `User`/`UPnP` documented in
     * the OpenAPI spec return "Invalid request parameters" (errorCode -1001) on this controller.
     *
     * @param type - Port forwarding type: 'User' or 'UPnP'
     * @param siteId - Optional site ID (uses default if not provided)
     * @param page - Page number (required by API, default: 1)
     * @param pageSize - Page size (required by API, range: 1-1000, default: 10)
     */
    public async getPortForwardingStatus(type: 'User' | 'UPnP', siteId?: string, page = 1, pageSize = 10): Promise<PaginatedResult<unknown>> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);

        if (type === 'User' && this.hasInternalApi) {
            logger.info('Using internal API for getPortForwardingStatus (User)');
            const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/transmission/portForwardings`;
            const response = await this.internalRequest!.get<OmadaApiResponse<PaginatedResult<unknown>>>(path, {
                currentPage: page,
                currentPageSize: pageSize,
            });
            return this.internalRequest!.ensureSuccess(response);
        }

        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/insight/port-forwarding/${encodeURIComponent(type.toLowerCase())}`);

        const response = await this.request.get<OmadaApiResponse<PaginatedResult<unknown>>>(path, {
            page,
            pageSize,
        });

        return this.request.ensureSuccess(response);
    }

    /**
     * Get LAN network list (v2 API) with pagination.
     * OperationId: getLanNetworkListV2
     */
    public async getLanNetworkList(siteId?: string): Promise<unknown[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/lan-networks`, 'v2');
        return await this.request.fetchPaginated<unknown>(path);
    }

    /**
     * Get LAN profile list with pagination.
     * OperationId: getLanProfileList
     */
    public async getLanProfileList(siteId?: string): Promise<unknown[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/lan-profiles`);
        return await this.request.fetchPaginated<unknown>(path);
    }

    /**
     * Get WLAN group list.
     * OperationId: getWlanGroupList
     */
    public async getWlanGroupList(siteId?: string): Promise<unknown[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/wireless-network/wlans`);
        const response = await this.request.get<OmadaApiResponse<unknown[]>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Get SSID list for a specific WLAN group.
     * OperationId: getSsidList
     *
     * @param wlanId - WLAN group ID (can be obtained from getWlanGroupList)
     */
    public async getSsidList(wlanId: string, siteId?: string): Promise<unknown[]> {
        if (!wlanId) {
            throw new Error('A wlanId must be provided. Use getWlanGroupList to get available WLAN group IDs.');
        }

        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids`);
        return await this.request.fetchPaginated<unknown>(path);
    }

    /**
     * Get detailed information for a specific SSID.
     * OperationId: getSsidDetail
     *
     * @param wlanId - WLAN group ID (can be obtained from getWlanGroupList)
     * @param ssidId - SSID ID (can be obtained from getSsidList)
     */
    public async getSsidDetail(wlanId: string, ssidId: string, siteId?: string): Promise<unknown> {
        if (!wlanId) {
            throw new Error('A wlanId must be provided. Use getWlanGroupList to get available WLAN group IDs.');
        }
        if (!ssidId) {
            throw new Error('An ssidId must be provided. Use getSsidList to get available SSID IDs.');
        }

        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(
            `/sites/${encodeURIComponent(resolvedSiteId)}/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids/${encodeURIComponent(ssidId)}`
        );
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Update an SSID's basic config (v1 API): name, band, security, VLAN, PSK, PMF, 802.11r, etc.
     * This does NOT control ssidEnable (use setSsidEnable) and does not touch schedule, rate
     * limit/control, MAC filter, multicast, or Hotspot 2.0 settings — those are separate
     * sub-resource endpoints the Omada Open API exposes independently.
     * Required fields per Omada's spec: band, broadcast, enable11r, guestNetEnable, mloEnable,
     * name, pmfMode, security, vlanEnable.
     *
     * @param wlanId - WLAN group ID (can be obtained from getWlanGroupList)
     * @param ssidId - SSID ID (can be obtained from getSsidList)
     */
    public async updateSsid(wlanId: string, ssidId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        if (!wlanId) {
            throw new Error('A wlanId must be provided. Use getWlanGroupList to get available WLAN group IDs.');
        }
        if (!ssidId) {
            throw new Error('An ssidId must be provided. Use getSsidList to get available SSID IDs.');
        }

        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(
            `/sites/${encodeURIComponent(resolvedSiteId)}/wireless-network/wlans/${encodeURIComponent(wlanId)}/ssids/${encodeURIComponent(ssidId)}/update-basic-config`
        );
        const response = await this.request.request<OmadaApiResponse<unknown>>({ method: 'PATCH', url: path, data });
        return this.request.ensureSuccess(response);
    }

    /**
     * Enable or disable an SSID network-wide.
     * Not part of the documented Open API surface — confirmed by capturing the controller's own
     * web UI network traffic, since neither PUT/PATCH on /ssids/{ssidId} (405, GET/DELETE only)
     * nor the update-basic-config sub-resource honors an ssidEnable field.
     *
     * @param ssidId - SSID ID (can be obtained from getSsidList)
     */
    public async setSsidEnable(ssidId: string, enable: boolean, siteId?: string): Promise<unknown> {
        if (!ssidId) {
            throw new Error('An ssidId must be provided. Use getSsidList to get available SSID IDs.');
        }

        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/wireless-network/ssids/${encodeURIComponent(ssidId)}/enable`);
        const response = await this.request.request<OmadaApiResponse<unknown>>({ method: 'PATCH', url: path, data: { ssidEnable: enable } });
        return this.request.ensureSuccess(response);
    }

    /**
     * Get firewall settings for a site.
     * OperationId: getFirewallSetting
     */
    public async getFirewallSetting(siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/firewall`);
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Create a new LAN network (v2 API).
     */
    public async createLanNetwork(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/lan-networks`, 'v2');
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, data);
        return this.request.ensureSuccess(response);
    }

    /**
     * Update an existing LAN network (v2 API).
     */
    public async updateLanNetwork(networkId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/lan-networks/${encodeURIComponent(networkId)}`, 'v2');
        const response = await this.request.put<OmadaApiResponse<unknown>>(path, data);
        return this.request.ensureSuccess(response);
    }

    /**
     * Delete a LAN network (v2 API).
     */
    public async deleteLanNetwork(networkId: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/lan-networks/${encodeURIComponent(networkId)}`, 'v2');
        const response = await this.request.delete<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Create a new LAN profile (v1 API).
     */
    public async createLanProfile(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/lan-profiles`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, data);
        return this.request.ensureSuccess(response);
    }

    /**
     * Update an existing LAN profile (v1 API).
     */
    public async updateLanProfile(profileId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/lan-profiles/${encodeURIComponent(profileId)}`);
        const response = await this.request.put<OmadaApiResponse<unknown>>(path, data);
        return this.request.ensureSuccess(response);
    }

    /**
     * Update firewall settings for a site (v1 API).
     */
    public async updateFirewallSetting(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/firewall`);
        const response = await this.request.put<OmadaApiResponse<unknown>>(path, data);
        return this.request.ensureSuccess(response);
    }

    /**
     * Get paginated events for a site (v1 API).
     * The Open API spec's path is `/sites/{siteId}/logs/events`, not `/sites/{siteId}/events`
     * — the latter 404s. `filters.timeStart`/`filters.timeEnd` (epoch milliseconds) are required
     * by the API; default to the last 7 days when not supplied, matching the default window the
     * sibling `audit-logs` endpoint applies internally when its own time filter is omitted.
     */
    public async listEvents(siteId?: string, page = 1, pageSize = 10, timeStart?: number, timeEnd?: number): Promise<PaginatedResult<unknown>> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const resolvedTimeEnd = timeEnd ?? Date.now();
        const resolvedTimeStart = timeStart ?? resolvedTimeEnd - 7 * 24 * 60 * 60 * 1000;
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/logs/events`);
        const response = await this.request.get<OmadaApiResponse<PaginatedResult<unknown>>>(path, {
            page,
            pageSize,
            'filters.timeStart': resolvedTimeStart,
            'filters.timeEnd': resolvedTimeEnd,
        });
        return this.request.ensureSuccess(response);
    }

    /**
     * Get paginated audit logs for a site (v1 API): system logs and configuration changes.
     * The Open API spec's path is `/sites/{siteId}/audit-logs`, not `/sites/{siteId}/logs`
     * — the latter 404s.
     */
    public async listLogs(siteId?: string, page = 1, pageSize = 10): Promise<PaginatedResult<unknown>> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/audit-logs`);
        const response = await this.request.get<OmadaApiResponse<PaginatedResult<unknown>>>(path, {
            page,
            pageSize,
        });
        return this.request.ensureSuccess(response);
    }

    /**
     * Update a switch port configuration (v1 API).
     */
    public async updateSwitchPort(switchMac: string, portId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(
            `/sites/${encodeURIComponent(resolvedSiteId)}/switches/${encodeURIComponent(switchMac)}/ports/${encodeURIComponent(portId)}`
        );
        const response = await this.request.request<OmadaApiResponse<unknown>>({ method: 'PATCH', url: path, data });
        return this.request.ensureSuccess(response);
    }

    /**
     * List firewall ACL rules for a site.
     * Uses the internal web UI API when web credentials are configured (required for OC200),
     * otherwise falls back to the Open API.
     */
    public async listFirewallAcls(siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);

        if (this.hasInternalApi) {
            logger.info('Using internal API for listFirewallAcls');
            const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/firewall/acls`;
            const response = await this.internalRequest!.get<OmadaApiResponse<unknown>>(path, {
                type: 0,
                currentPage: 1,
                currentPageSize: 100,
            });
            return this.internalRequest!.ensureSuccess(response);
        }

        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/setting/firewall/acls`);
        return await this.request.fetchPaginated<unknown>(path);
    }

    /**
     * Create a firewall ACL rule.
     * Uses the internal web UI API when web credentials are configured (required for OC200),
     * otherwise falls back to the Open API.
     */
    public async createFirewallAcl(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);

        if (this.hasInternalApi) {
            logger.info('Using internal API for createFirewallAcl');
            const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/firewall/acls`;
            const response = await this.internalRequest!.post<OmadaApiResponse<unknown>>(path, data);
            return this.internalRequest!.ensureSuccess(response);
        }

        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/setting/firewall/acls`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, data);
        return this.request.ensureSuccess(response);
    }

    /**
     * Update an existing firewall ACL rule.
     * Uses the internal web UI API when web credentials are configured (required for OC200),
     * otherwise falls back to the Open API.
     */
    public async updateFirewallAcl(aclId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);

        if (this.hasInternalApi) {
            logger.info('Using internal API for updateFirewallAcl');
            const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/firewall/acls/${encodeURIComponent(aclId)}`;
            const response = await this.internalRequest!.put<OmadaApiResponse<unknown>>(path, data);
            return this.internalRequest!.ensureSuccess(response);
        }

        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/setting/firewall/acls/${encodeURIComponent(aclId)}`);
        const response = await this.request.put<OmadaApiResponse<unknown>>(path, data);
        return this.request.ensureSuccess(response);
    }

    /**
     * Delete a firewall ACL rule.
     * Uses the internal web UI API when web credentials are configured (required for OC200),
     * otherwise falls back to the Open API.
     */
    public async deleteFirewallAcl(aclId: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);

        if (this.hasInternalApi) {
            logger.info('Using internal API for deleteFirewallAcl');
            const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/firewall/acls/${encodeURIComponent(aclId)}`;
            const response = await this.internalRequest!.delete<OmadaApiResponse<unknown>>(path);
            return this.internalRequest!.ensureSuccess(response);
        }

        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/setting/firewall/acls/${encodeURIComponent(aclId)}`);
        const response = await this.request.delete<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * List IP/Port groups for a site (internal API only).
     * These groups can be used as source/destination in firewall ACL rules.
     * Requires OMADA_WEB_USERNAME and OMADA_WEB_PASSWORD to be configured.
     */
    public async listIpGroups(siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);

        if (!this.hasInternalApi) {
            throw new Error(
                'listIpGroups requires the internal web UI API. ' +
                    'Set OMADA_WEB_USERNAME and OMADA_WEB_PASSWORD environment variables to enable it.'
            );
        }

        const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/profiles/groups`;
        const response = await this.internalRequest!.get<OmadaApiResponse<unknown>>(path, {
            currentPage: 1,
            currentPageSize: 100,
        });
        return this.internalRequest!.ensureSuccess(response);
    }

    /**
     * List static routes for a site.
     * Uses the internal web UI API (`/setting/transmission/staticRoutings`) when web credentials
     * are configured — confirmed by capturing the controller's own web UI network traffic; the
     * public Open API path this previously called (`/setting/routes`) 404s and appears to not
     * exist. Falls back to that public path (unverified) when internal auth isn't available.
     * Only fetches the first 100 routes; fine for a typical site's route table but not truly
     * paginated like the public-API-backed list methods.
     */
    public async listRoutes(siteId?: string): Promise<unknown[]> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);

        if (this.hasInternalApi) {
            logger.info('Using internal API for listRoutes');
            const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/transmission/staticRoutings`;
            const response = await this.internalRequest!.get<OmadaApiResponse<PaginatedResult<unknown>>>(path, {
                currentPage: 1,
                currentPageSize: 100,
            });
            const result = this.internalRequest!.ensureSuccess(response);
            return result.data ?? [];
        }

        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/setting/routes`);
        return await this.request.fetchPaginated<unknown>(path);
    }

    /**
     * Create a static route. Internal API only — there is no known public Open API equivalent.
     * `data` shape confirmed by capturing the controller's own web UI traffic, e.g.:
     * `{ name, status, destinations: ["203.0.113.0/24"], routeType: 0, nextHopIp: "192.168.0.1", metric: "15" }`
     * (`routeType: 0` = Next Hop; the UI also offers an Interface route type, not yet captured).
     */
    public async createRoute(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        this.requireInternalApi('createRoute');

        const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/transmission/staticRoutings`;
        const response = await this.internalRequest!.post<OmadaApiResponse<unknown>>(path, data);
        return this.internalRequest!.ensureSuccess(response);
    }

    /**
     * Update an existing static route. Internal API only. Same body shape as `createRoute`.
     */
    public async updateRoute(routeId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        this.requireInternalApi('updateRoute');

        const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/transmission/staticRoutings/${encodeURIComponent(routeId)}`;
        const response = await this.internalRequest!.put<OmadaApiResponse<unknown>>(path, data);
        return this.internalRequest!.ensureSuccess(response);
    }

    /**
     * Delete a static route by its ID. Internal API only.
     */
    public async deleteRoute(routeId: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        this.requireInternalApi('deleteRoute');

        const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/transmission/staticRoutings/${encodeURIComponent(routeId)}`;
        const response = await this.internalRequest!.delete<OmadaApiResponse<unknown>>(path);
        return this.internalRequest!.ensureSuccess(response);
    }

    /**
     * Create a port forwarding rule. Internal API only — there is no known public Open API
     * equivalent (the public `insight/port-forwarding` path is read-only and, per
     * `getPortForwardingStatus`, doesn't reliably work on this controller anyway).
     * `data` shape confirmed by capturing the controller's own web UI traffic, e.g.:
     * `{ name, status, dMZ: false, externalPort: "59999", forwardIp: "192.168.0.253",
     *   forwardPort: "59999", protocol: 1, from: 0, interfaceWanPortId: ["<wan-port-id>"],
     *   virtualWanId: [], featureDescription: [] }`
     * (`protocol`: 0 = All, 1 = TCP, 2 = UDP. `interfaceWanPortId` values come from the WAN port
     * IDs in `getInternetInfo`'s `wanPortSettings`.)
     */
    public async createPortForward(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        this.requireInternalApi('createPortForward');

        const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/transmission/portForwardings`;
        const response = await this.internalRequest!.post<OmadaApiResponse<unknown>>(path, data);
        return this.internalRequest!.ensureSuccess(response);
    }

    /**
     * Update an existing port forwarding rule. Internal API only. Same body shape as
     * `createPortForward`.
     */
    public async updatePortForward(ruleId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        this.requireInternalApi('updatePortForward');

        const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/transmission/portForwardings/${encodeURIComponent(ruleId)}`;
        const response = await this.internalRequest!.put<OmadaApiResponse<unknown>>(path, data);
        return this.internalRequest!.ensureSuccess(response);
    }

    /**
     * Delete a port forwarding rule by its ID. Internal API only.
     */
    public async deletePortForward(ruleId: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        this.requireInternalApi('deletePortForward');

        const path = `/sites/${encodeURIComponent(resolvedSiteId)}/setting/transmission/portForwardings/${encodeURIComponent(ruleId)}`;
        const response = await this.internalRequest!.delete<OmadaApiResponse<unknown>>(path);
        return this.internalRequest!.ensureSuccess(response);
    }

    /**
     * Throw a clear, actionable error when an internal-API-only operation is called without
     * OMADA_WEB_USERNAME/OMADA_WEB_PASSWORD configured, instead of a confusing null-pointer
     * failure from calling a method on `this.internalRequest` when it's undefined.
     */
    private requireInternalApi(operation: string): void {
        if (!this.hasInternalApi) {
            throw new Error(
                `${operation} requires the internal web UI API. ` +
                    'Set OMADA_WEB_USERNAME and OMADA_WEB_PASSWORD environment variables to enable it.'
            );
        }
    }
}
