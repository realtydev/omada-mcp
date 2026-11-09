import type { OmadaApiResponse } from '../types/index.js';
import { clientUpdateSchema, customClientRateLimitSchema } from '../utils/client-update-schema.js';

import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

/**
 * Device and client action operations for the Omada API.
 * Covers reboot, adopt, block, and unblock actions.
 */
export class ActionOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string, version?: string) => string
    ) {}

    /**
     * Reboot a device by MAC address (v1 API).
     */
    public async rebootDevice(deviceMac: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/devices/${encodeURIComponent(deviceMac)}/reboot`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, {});
        return this.request.ensureSuccess(response);
    }

    /**
     * Adopt a device by MAC address (v1 API).
     */
    public async adoptDevice(deviceMac: string, siteId?: string, credentials: { username?: string; password?: string } = {}): Promise<unknown> {
        for (const [key, value] of Object.entries(credentials)) {
            if (
                !['username', 'password'].includes(key) ||
                (value !== undefined && (typeof value !== 'string' || value.length < 1 || value.length > 64))
            ) {
                throw new Error('Adoption accepts optional username and password strings of 1 to 64 characters');
            }
        }
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/devices/${encodeURIComponent(deviceMac)}/start-adopt`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, credentials);
        return this.request.ensureSuccess(response);
    }

    /**
     * Block a client by MAC address (v1 API).
     */
    public async blockClient(clientMac: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients/${encodeURIComponent(clientMac)}/block`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, {});
        return this.request.ensureSuccess(response);
    }

    /**
     * Unblock a client by MAC address (v1 API).
     */
    public async unblockClient(clientMac: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients/${encodeURIComponent(clientMac)}/unblock`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, {});
        return this.request.ensureSuccess(response);
    }

    /**
     * Reconnect a client by MAC address (v1 API).
     */
    public async reconnectClient(clientMac: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/clients/${encodeURIComponent(clientMac)}/reconnect`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, {});
        return this.request.ensureSuccess(response);
    }

    /**
     * Update a client's settings (v1 API).
     */
    public async updateClient(clientMac: string, data: Record<string, unknown>, siteId?: string, dryRun = false): Promise<unknown> {
        // Validate the entire request before sending any of its independent writes.
        const settings = clientUpdateSchema.parse(data);
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const base = `/sites/${encodeURIComponent(resolvedSiteId)}/clients/${encodeURIComponent(clientMac)}`;
        const legacyRate = [settings.rateLimitEnable, settings.upLimit, settings.downLimit].some((value) => value !== undefined);
        let current: Record<string, unknown> = {};
        if (legacyRate || settings.fixedIp !== undefined) {
            const response = await this.request.get<OmadaApiResponse<Record<string, unknown>>>(this.buildPath(base));
            current = this.request.ensureSuccess(response);
            if (!current || typeof current !== 'object' || Array.isArray(current)) {
                throw new Error('Controller returned no client detail; no client settings were written');
            }
        }
        const operations: { setting: string; path: string; body: unknown }[] = [];
        if (settings.name !== undefined) {
            operations.push({ setting: 'name', path: this.buildPath(`${base}/name`), body: { name: settings.name } });
        }
        let rateLimit = settings.rateLimit;
        if (legacyRate) {
            const previous = current.rateLimit as Record<string, unknown> | undefined;
            if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
                throw new Error('Cannot preserve the existing rate limit; use a complete rateLimit configuration');
            }
            if (previous.rateLimitId && settings.rateLimitEnable !== false) {
                throw new Error('Client uses a rate-limit profile; use a complete rateLimit configuration to replace it');
            }
            const custom = {
                upEnable: previous.enable === false && settings.rateLimitEnable !== true ? false : previous.upEnable,
                upLimit: previous.upLimit,
                upUnit: previous.upUnit,
                downEnable: previous.enable === false && settings.rateLimitEnable !== true ? false : previous.downEnable,
                downLimit: previous.downLimit,
                downUnit: previous.downUnit,
            };
            if (settings.upLimit !== undefined) Object.assign(custom, { upEnable: true, upLimit: settings.upLimit, upUnit: 1 });
            if (settings.downLimit !== undefined) Object.assign(custom, { downEnable: true, downLimit: settings.downLimit, downUnit: 1 });
            if (settings.rateLimitEnable === false) Object.assign(custom, { upEnable: false, downEnable: false });
            // Disabled directions may omit values in the detail response. Supply valid inert defaults.
            for (const direction of ['up', 'down'] as const) {
                if (custom[`${direction}Enable`] === false) {
                    custom[`${direction}Limit`] ??= 1;
                    custom[`${direction}Unit`] ??= 1;
                }
            }
            const validated = customClientRateLimitSchema.safeParse(custom);
            if (!validated.success) throw new Error('Cannot preserve the existing rate limit; use a complete rateLimit configuration');
            if (settings.rateLimitEnable === true && !validated.data.upEnable && !validated.data.downEnable) {
                throw new Error('Enabling rate limiting requires at least one enabled direction or an explicit limit');
            }
            rateLimit = { mode: 0, customRateLimit: validated.data };
        }
        if (rateLimit !== undefined) operations.push({ setting: 'rateLimit', path: this.buildPath(`${base}/ratelimit`), body: rateLimit });
        if (settings.fixedIp !== undefined) {
            const previous = current.ipSetting;
            if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
                throw new Error('Cannot preserve existing client IP settings; no client settings were written');
            }
            const body: Record<string, unknown> = { useFixedAddr: settings.fixedIp !== '' };
            for (const key of ['netId', 'serverMac', 'serverStackId', 'serverType']) {
                const value = (previous as Record<string, unknown>)[key];
                if (value !== undefined && value !== null) {
                    if (typeof value !== 'string') throw new Error(`Cannot preserve client IP setting ${key}; no client settings were written`);
                    body[key] = value;
                }
            }
            if (settings.fixedIp !== '') body.ip = settings.fixedIp;
            operations.push({
                setting: 'fixedIp',
                path: this.buildPath(
                    `/network/sites/${encodeURIComponent(resolvedSiteId)}/cmd/clients/${encodeURIComponent(clientMac)}/update-ipSetting`
                ),
                body,
            });
        }
        if (dryRun) return { dryRun: true, written: false, operations };
        const completed: string[] = [];
        const results: Record<string, unknown> = {};
        for (const operation of operations) {
            try {
                const response = await this.request.request<OmadaApiResponse<unknown>>({
                    method: 'PATCH',
                    url: operation.path,
                    data: operation.body,
                });
                results[operation.setting] = this.request.ensureSuccess(response);
                completed.push(operation.setting);
            } catch (error) {
                throw new Error(
                    `Client update failed at ${operation.setting}; completed settings: ${completed.join(', ') || 'none'}. ` +
                        'The failed write may have applied; inspect client settings before retrying. ' +
                        (error instanceof Error ? error.message : String(error)),
                    { cause: error }
                );
            }
        }
        return { dryRun: false, written: true, completed, results };
    }

    /** The Open API exposes locating a device and a site-wide LED policy, not this device-level setting. */
    public setDeviceLed(_deviceMac: string, _ledSetting: number, _siteId?: string): Promise<unknown> {
        return Promise.reject(
            new Error(
                'Per-device LED settings are not supported by the Omada Open API. Use locateDevice to identify one device, or setSiteLed to change the entire site.'
            )
        );
    }

    public async locateDevice(deviceMac: string, enable: boolean, siteId?: string): Promise<unknown> {
        if (typeof enable !== 'boolean') throw new Error('enable must be a boolean');
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/devices/${encodeURIComponent(deviceMac)}/locate`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, { locateEnable: enable });
        return this.request.ensureSuccess(response);
    }

    public async setSiteLed(enable: boolean, siteId?: string): Promise<unknown> {
        if (typeof enable !== 'boolean') throw new Error('enable must be a boolean');
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/led`);
        const response = await this.request.put<OmadaApiResponse<unknown>>(path, { enable });
        return this.request.ensureSuccess(response);
    }

    /**
     * Get firmware details for a device (v1 API).
     * The Open API spec's path is `/devices/{deviceMac}/latest-firmware-info`, not
     * `/devices/{deviceMac}/firmware` — the latter 404s on every device.
     */
    public async getFirmwareDetails(deviceMac: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/devices/${encodeURIComponent(deviceMac)}/latest-firmware-info`);
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }

    /**
     * Start firmware upgrade for a device (v1 API).
     */
    public async startFirmwareUpgrade(deviceMac: string, siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/devices/${encodeURIComponent(deviceMac)}/start-online-upgrade`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, undefined);
        return this.request.ensureSuccess(response);
    }

    /**
     * Connect or disconnect a gateway WAN port (v1 API).
     */
    public async setGatewayWanConnect(gatewayMac: string, portId: number, action: 'connect' | 'disconnect', siteId?: string): Promise<unknown> {
        const resolvedSiteId = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolvedSiteId)}/gateways/${encodeURIComponent(gatewayMac)}/internet-state`);
        const response = await this.request.post<OmadaApiResponse<unknown>>(path, {
            portId,
            operation: action === 'connect' ? 1 : 0,
        });
        return this.request.ensureSuccess(response);
    }
}
