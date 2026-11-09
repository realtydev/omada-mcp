import type { OmadaApiResponse } from '../types/index.js';
import type { InternalRequestHandler } from './internalRequest.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

export type VpnConnectionKind = 'tunnel' | 'ipsec' | 's2s' | 'server' | 'client';

export interface ListVpnConnectionsOptions {
    siteId?: string;
    kind?: VpnConnectionKind;
    vpnType?: number;
}

/** Read-only monitoring. Newer endpoint contracts were exercised on Controller 6.3.0.45. */
export class MonitoringOperations {
    private internalRequest?: InternalRequestHandler;

    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string
    ) {}

    public setInternalRequest(request: InternalRequestHandler): void {
        this.internalRequest = request;
    }

    public async getSiteTopology(siteId?: string): Promise<unknown> {
        if (!this.internalRequest) {
            throw new Error('Site topology requires OMADA_WEB_USERNAME and OMADA_WEB_PASSWORD for the controller web API.');
        }
        const resolved = this.site.resolveSiteId(siteId);
        const response = await this.internalRequest.get<OmadaApiResponse<unknown>>(`/sites/${encodeURIComponent(resolved)}/topology`);
        return this.internalRequest.ensureSuccess(response);
    }

    public async listVpnConnections(options: ListVpnConnectionsOptions = {}): Promise<unknown[]> {
        const siteId = this.site.resolveSiteId(options.siteId);
        const kind = options.kind ?? 'tunnel';
        const parameters: Record<string, unknown> = {};
        if (options.vpnType !== undefined) parameters['filters.vpnType'] = options.vpnType;
        if (['s2s', 'server', 'client'].includes(kind) && options.vpnType === undefined) {
            throw new Error(`vpnType is required for ${kind} VPN status on supported controllers; provide the controller protocol code.`);
        }
        return await this.request.fetchPaginated<unknown>(
            this.buildPath(`/sites/${encodeURIComponent(siteId)}/setting/vpn/stats/${kind}`),
            parameters,
            100
        );
    }

    public async getGatewayWanSpeedTestResults(gatewayMac: string, siteId?: string): Promise<unknown> {
        const resolved = this.site.resolveSiteId(siteId);
        const path = this.buildPath(`/sites/${encodeURIComponent(resolved)}/gateways/${encodeURIComponent(gatewayMac)}/speedTestResult`);
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        return this.request.ensureSuccess(response);
    }
}
