import https from 'node:https';

import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

import type { EnvironmentConfig } from '../config.js';
import type {
    ActiveClientInfo,
    ClientActivity,
    ClientPastConnection,
    GetClientActivityOptions,
    GetDeviceStatsOptions,
    GetThreatListOptions,
    ListClientsPastConnectionsOptions,
    OmadaClientInfo,
    OmadaDeviceInfo,
    OmadaDeviceStats,
    OmadaSiteSummary,
    OswStackDetail,
    PaginatedResult,
    ThreatInfo,
} from '../types/index.js';

import { logger } from '../utils/logger.js';

import { ActionOperations } from './action.js';
import { AuthManager } from './auth.js';
import { ClientOperations } from './client.js';
import { DeviceOperations } from './device.js';
import { GenericOperations } from './generic.js';
import { InternalAuthManager } from './internalAuth.js';
import { InternalRequestHandler } from './internalRequest.js';
import { NetworkOperations } from './network.js';
import { RequestHandler } from './request.js';
import { SecurityOperations } from './security.js';
import { SiteOperations } from './site.js';
import { SwitchOperations } from './switch.js';

export type OmadaClientOptions = EnvironmentConfig;

/**
 * Main client for interacting with the TP-Link Omada API.
 * Organized by API tag with dedicated operation classes for each domain.
 */
export class OmadaClient {
    private readonly http: AxiosInstance;

    private readonly auth: AuthManager;

    private readonly request: RequestHandler;

    private readonly siteOps: SiteOperations;

    private readonly deviceOps: DeviceOperations;

    private readonly clientOps: ClientOperations;

    private readonly securityOps: SecurityOperations;

    private readonly networkOps: NetworkOperations;

    private readonly actionOps: ActionOperations;

    private readonly genericOps: GenericOperations;

    private readonly switchOps: SwitchOperations;

    private readonly omadacId: string;

    constructor(options: OmadaClientOptions) {
        this.omadacId = options.omadacId;

        const axiosOptions: AxiosRequestConfig = {
            baseURL: options.baseUrl,
            httpsAgent: new https.Agent({ rejectUnauthorized: options.strictSsl }),
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
        };

        if (options.requestTimeout) {
            axiosOptions.timeout = options.requestTimeout;
        }

        this.http = axios.create(axiosOptions);

        // Initialize operation modules
        this.auth = new AuthManager(this.http, options.clientId, options.clientSecret, options.omadacId);
        this.request = new RequestHandler(this.http, this.auth);
        this.siteOps = new SiteOperations(this.request, this.buildOmadaPath.bind(this), options.siteId);
        this.deviceOps = new DeviceOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.clientOps = new ClientOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.securityOps = new SecurityOperations(this.request, this.buildOmadaPath.bind(this));
        this.networkOps = new NetworkOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.actionOps = new ActionOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.genericOps = new GenericOperations(this.request, this.buildOmadaPath.bind(this));
        this.switchOps = new SwitchOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));

        // Initialize internal API support if web credentials are configured
        if (options.webUsername && options.webPassword) {
            const internalAuth = new InternalAuthManager(this.http, options.webUsername, options.webPassword, options.omadacId);
            const internalReq = new InternalRequestHandler(this.http, internalAuth, options.omadacId);
            this.networkOps.setInternalRequest(internalReq);
            logger.info('Internal web UI API enabled for ACL management');
        }
    }

    // Site operations
    public async listSites(): Promise<OmadaSiteSummary[]> {
        return await this.siteOps.listSites();
    }

    // Device operations
    public async listDevices(siteId?: string): Promise<OmadaDeviceInfo[]> {
        return await this.deviceOps.listDevices(siteId);
    }

    public async getDevice(identifier: string, siteId?: string): Promise<OmadaDeviceInfo | undefined> {
        return await this.deviceOps.getDevice(identifier, siteId);
    }

    public async getSwitchStackDetail(stackId: string, siteId?: string): Promise<OswStackDetail> {
        return await this.deviceOps.getSwitchStackDetail(stackId, siteId);
    }

    public async searchDevices(searchKey: string): Promise<OmadaDeviceInfo[]> {
        return await this.deviceOps.searchDevices(searchKey);
    }

    public async listDevicesStats(options: GetDeviceStatsOptions): Promise<OmadaDeviceStats> {
        return await this.deviceOps.listDevicesStats(options);
    }

    // Client operations
    public async listClients(siteId?: string): Promise<OmadaClientInfo[]> {
        return await this.clientOps.listClients(siteId);
    }

    public async getClient(identifier: string, siteId?: string): Promise<OmadaClientInfo | undefined> {
        return await this.clientOps.getClient(identifier, siteId);
    }

    public async listMostActiveClients(siteId?: string): Promise<ActiveClientInfo[]> {
        return await this.clientOps.listMostActiveClients(siteId);
    }

    public async listClientsActivity(options?: GetClientActivityOptions): Promise<ClientActivity[]> {
        return await this.clientOps.listClientsActivity(options);
    }

    public async listClientsPastConnections(options: ListClientsPastConnectionsOptions): Promise<ClientPastConnection[]> {
        return await this.clientOps.listClientsPastConnections(options);
    }

    // Security operations
    public async getThreatList(options: GetThreatListOptions): Promise<PaginatedResult<ThreatInfo>> {
        return await this.securityOps.getThreatList(options);
    }

    // Network operations
    public async getInternetInfo(siteId?: string): Promise<unknown> {
        return await this.networkOps.getInternetInfo(siteId);
    }

    public async getPortForwardingStatus(type: 'User' | 'UPnP', siteId?: string, page = 1, pageSize = 10): Promise<PaginatedResult<unknown>> {
        return await this.networkOps.getPortForwardingStatus(type, siteId, page, pageSize);
    }

    public async getLanNetworkList(siteId?: string): Promise<unknown[]> {
        return await this.networkOps.getLanNetworkList(siteId);
    }

    public async getLanProfileList(siteId?: string): Promise<unknown[]> {
        return await this.networkOps.getLanProfileList(siteId);
    }

    public async getWlanGroupList(siteId?: string): Promise<unknown[]> {
        return await this.networkOps.getWlanGroupList(siteId);
    }

    public async getSsidList(wlanId: string, siteId?: string): Promise<unknown[]> {
        return await this.networkOps.getSsidList(wlanId, siteId);
    }

    public async getSsidDetail(wlanId: string, ssidId: string, siteId?: string): Promise<unknown> {
        return await this.networkOps.getSsidDetail(wlanId, ssidId, siteId);
    }

    public async getFirewallSetting(siteId?: string): Promise<unknown> {
        return await this.networkOps.getFirewallSetting(siteId);
    }

    // Network write operations
    public async updateSsid(wlanId: string, ssidId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.updateSsid(wlanId, ssidId, data, siteId);
    }

    public async setSsidEnable(ssidId: string, enable: boolean, siteId?: string): Promise<unknown> {
        return await this.networkOps.setSsidEnable(ssidId, enable, siteId);
    }

    public async createLanNetwork(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.createLanNetwork(data, siteId);
    }

    public async updateLanNetwork(networkId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.updateLanNetwork(networkId, data, siteId);
    }

    public async deleteLanNetwork(networkId: string, siteId?: string): Promise<unknown> {
        return await this.networkOps.deleteLanNetwork(networkId, siteId);
    }

    public async createLanProfile(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.createLanProfile(data, siteId);
    }

    public async updateLanProfile(profileId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.updateLanProfile(profileId, data, siteId);
    }

    public async updateFirewallSetting(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.updateFirewallSetting(data, siteId);
    }

    public async listEvents(
        siteId?: string,
        page?: number,
        pageSize?: number,
        timeStart?: number,
        timeEnd?: number
    ): Promise<PaginatedResult<unknown>> {
        return await this.networkOps.listEvents(siteId, page, pageSize, timeStart, timeEnd);
    }

    public async listLogs(siteId?: string, page?: number, pageSize?: number): Promise<PaginatedResult<unknown>> {
        return await this.networkOps.listLogs(siteId, page, pageSize);
    }

    // Device and client actions
    public async rebootDevice(deviceMac: string, siteId?: string): Promise<unknown> {
        return await this.actionOps.rebootDevice(deviceMac, siteId);
    }

    public async adoptDevice(deviceMac: string, siteId?: string): Promise<unknown> {
        return await this.actionOps.adoptDevice(deviceMac, siteId);
    }

    public async blockClient(clientMac: string, siteId?: string): Promise<unknown> {
        return await this.actionOps.blockClient(clientMac, siteId);
    }

    public async unblockClient(clientMac: string, siteId?: string): Promise<unknown> {
        return await this.actionOps.unblockClient(clientMac, siteId);
    }

    public async reconnectClient(clientMac: string, siteId?: string): Promise<unknown> {
        return await this.actionOps.reconnectClient(clientMac, siteId);
    }

    public async updateClient(clientMac: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.actionOps.updateClient(clientMac, data, siteId);
    }

    public async setDeviceLed(deviceMac: string, ledSetting: number, siteId?: string): Promise<unknown> {
        return await this.actionOps.setDeviceLed(deviceMac, ledSetting, siteId);
    }

    public async getFirmwareDetails(deviceMac: string, siteId?: string): Promise<unknown> {
        return await this.actionOps.getFirmwareDetails(deviceMac, siteId);
    }

    public async startFirmwareUpgrade(deviceMac: string, siteId?: string): Promise<unknown> {
        return await this.actionOps.startFirmwareUpgrade(deviceMac, siteId);
    }

    public async setGatewayWanConnect(gatewayMac: string, portId: string, action: 'connect' | 'disconnect', siteId?: string): Promise<unknown> {
        return await this.actionOps.setGatewayWanConnect(gatewayMac, portId, action, siteId);
    }

    // Network read/write operations (switch ports, firewall ACLs, routes)
    public async updateSwitchPort(switchMac: string, portId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.updateSwitchPort(switchMac, portId, data, siteId);
    }

    public async listFirewallAcls(siteId?: string): Promise<unknown> {
        return await this.networkOps.listFirewallAcls(siteId);
    }

    public async listIpGroups(siteId?: string): Promise<unknown> {
        return await this.networkOps.listIpGroups(siteId);
    }

    public async createFirewallAcl(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.createFirewallAcl(data, siteId);
    }

    public async updateFirewallAcl(aclId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.updateFirewallAcl(aclId, data, siteId);
    }

    public async deleteFirewallAcl(aclId: string, siteId?: string): Promise<unknown> {
        return await this.networkOps.deleteFirewallAcl(aclId, siteId);
    }

    public async listRoutes(siteId?: string): Promise<unknown[]> {
        return await this.networkOps.listRoutes(siteId);
    }

    public async createRoute(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.createRoute(data, siteId);
    }

    public async updateRoute(routeId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.updateRoute(routeId, data, siteId);
    }

    public async deleteRoute(routeId: string, siteId?: string): Promise<unknown> {
        return await this.networkOps.deleteRoute(routeId, siteId);
    }

    public async createPortForward(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.createPortForward(data, siteId);
    }

    public async updatePortForward(ruleId: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.updatePortForward(ruleId, data, siteId);
    }

    public async deletePortForward(ruleId: string, siteId?: string): Promise<unknown> {
        return await this.networkOps.deletePortForward(ruleId, siteId);
    }

    // Switch operations
    public async getSwitch(switchMac: string, siteId?: string): Promise<unknown> {
        return await this.switchOps.getSwitch(switchMac, siteId);
    }

    public async setSwitchPortProfile(switchMac: string, port: number, profileId: string, siteId?: string): Promise<unknown> {
        return await this.switchOps.setSwitchPortProfile(switchMac, port, profileId, siteId);
    }

    public async setSwitchPortPoe(switchMac: string, port: number, poeMode: number, siteId?: string): Promise<unknown> {
        return await this.switchOps.setSwitchPortPoe(switchMac, port, poeMode, siteId);
    }

    public async setSwitchPortName(switchMac: string, port: number, name: string, siteId?: string): Promise<unknown> {
        return await this.switchOps.setSwitchPortName(switchMac, port, name, siteId);
    }

    public async setSwitchPortStatus(switchMac: string, port: number, status: number, siteId?: string): Promise<unknown> {
        return await this.switchOps.setSwitchPortStatus(switchMac, port, status, siteId);
    }

    public async setSwitchPortProfileOverride(switchMac: string, port: number, profileOverrideEnable: boolean, siteId?: string): Promise<unknown> {
        return await this.switchOps.setSwitchPortProfileOverride(switchMac, port, profileOverrideEnable, siteId);
    }

    public async batchSetSwitchPortProfile(switchMac: string, portList: number[], profileOverrideEnable: boolean, siteId?: string): Promise<unknown> {
        return await this.switchOps.batchSetSwitchPortProfile(switchMac, portList, profileOverrideEnable, siteId);
    }

    public async batchSetSwitchPortPoe(switchMac: string, portList: number[], poeMode: number, siteId?: string): Promise<unknown> {
        return await this.switchOps.batchSetSwitchPortPoe(switchMac, portList, poeMode, siteId);
    }

    public async batchSetSwitchPortStatus(switchMac: string, portList: number[], status: number, siteId?: string): Promise<unknown> {
        return await this.switchOps.batchSetSwitchPortStatus(switchMac, portList, status, siteId);
    }

    public async batchSetSwitchPortName(switchMac: string, portNameList: Array<{ port: number; name: string }>, siteId?: string): Promise<unknown> {
        return await this.switchOps.batchSetSwitchPortName(switchMac, portNameList, siteId);
    }

    public async startCableTest(switchMac: string, siteId?: string): Promise<unknown> {
        return await this.switchOps.startCableTest(switchMac, siteId);
    }

    public async getCableTestResults(switchMac: string, siteId?: string): Promise<unknown> {
        return await this.switchOps.getCableTestResults(switchMac, siteId);
    }

    public async getSwitchNetworks(switchMac: string, siteId?: string): Promise<unknown[]> {
        return await this.switchOps.getSwitchNetworks(switchMac, siteId);
    }

    public async setSwitchNetworks(switchMac: string, data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.switchOps.setSwitchNetworks(switchMac, data, siteId);
    }

    // Generic API operations
    public async genericApiCall(
        method: string,
        path: string,
        version?: string,
        body?: unknown,
        queryParams?: Record<string, unknown>
    ): Promise<unknown> {
        return await this.genericOps.genericApiCall(method, path, version, body, queryParams);
    }

    // Generic API call (raw)
    public async callApi<T = unknown>(config: AxiosRequestConfig): Promise<T> {
        return await this.request.request<T>(config);
    }

    /**
     * Build a full Omada API path from a relative path.
     * @param relativePath - The relative path to append to the base API path
     * @param version - The API version to use (default: 'v1')
     */
    private buildOmadaPath(relativePath: string, version = 'v1'): string {
        const normalized = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
        return `/openapi/${version}/${encodeURIComponent(this.omadacId)}${normalized}`;
    }
}
