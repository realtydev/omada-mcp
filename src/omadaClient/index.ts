import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

import type { EnvironmentConfig } from '../config.js';
import { createClientPolicyProxy, ToolAccessPolicy } from '../server/toolPolicy.js';
import type {
    ActiveClientInfo,
    ApRadioBand,
    ApRadioSettings,
    ClientActivity,
    ClientHistory,
    ClientPastConnection,
    GatewayWanStatus,
    GetClientActivityOptions,
    GetClientHistoryOptions,
    GetDeviceStatsOptions,
    GetThreatListOptions,
    ListClientsPastConnectionsOptions,
    OmadaClientInfo,
    OmadaDeviceInfo,
    OmadaDeviceStats,
    OmadaSiteSummary,
    OswStackDetail,
    PaginatedResult,
    SetApRadioResult,
    SetLogNotificationsOptions,
    SetLogNotificationsResult,
    ThreatInfo,
} from '../types/index.js';

import { logger } from '../utils/logger.js';
import type { SwitchWriteOptions } from '../utils/switch-port-safety.js';

import { ActionOperations } from './action.js';
import { ApRadioOperations } from './apRadio.js';
import { ApSsidOverrideOperations, type ApSsidOverrideUpdate } from './apSsidOverride.js';
import { AuthManager, type RequestAuthManager, WebAuthManager } from './auth.js';
import { type ControllerCapabilitiesResult, ControllerCapabilityOperations, type GetControllerCapabilitiesOptions } from './capabilities.js';
import { ClientOperations } from './client.js';
import { DeviceOperations } from './device.js';
import {
    type DhcpReservation,
    type DhcpReservationConfig,
    DhcpReservationOperations,
    type DhcpReservationUpdate,
    type DhcpReservationWriteResult,
} from './dhcpReservation.js';
import { type DiagnoseClientResult, type DiagnoseLogsResult, DiagnosticsOperations } from './diagnostics.js';
import { DiscoveryOperations, type DiscoveryPolicy, type ExecuteApiOperationOptions, type SearchApiOperationsOptions } from './discovery.js';
import { GenericOperations } from './generic.js';
import { createControllerHttpOptions } from './httpOptions.js';
import { InternalAuthManager } from './internalAuth.js';
import { InternalRequestHandler } from './internalRequest.js';
import { LogNotificationOperations } from './logNotification.js';
import { MonitorOperations, type SiteDashboardOptions, type SiteDashboardResult } from './monitor.js';
import { type ListVpnConnectionsOptions, MonitoringOperations } from './monitoring.js';
import { NetworkOperations } from './network.js';
import { NetworkChangeOperations, type NetworkChangeReceipt } from './networkChange.js';
import {
    type NetworkDiagnosticOptions,
    NetworkDiagnosticsOperations,
    type NetworkDiagnosticsResult,
    type WanDiagnosticOptions,
    type WifiHistoryOptions,
} from './networkDiagnostics.js';
import { RateLimitProfileOperations, type RateLimitProfileUpdate, type RateLimitProfileWriteResult } from './rateLimitProfile.js';
import { type PaginationReadOptions, RequestHandler } from './request.js';
import { type GetRfPlanningOptions, RfPlanningOperations } from './rfPlanning.js';
import { SecurityOperations } from './security.js';
import { SiteOperations } from './site.js';
import { SwitchOperations } from './switch.js';
import { type GetWifiAuditOptions, WifiAuditOperations, type WifiAuditResult } from './wifiAudit.js';

export type OmadaClientOptions = EnvironmentConfig;

/**
 * Main client for interacting with the TP-Link Omada API.
 * Organized by API tag with dedicated operation classes for each domain.
 */
export class OmadaClient {
    private readonly http: AxiosInstance;

    private readonly auth: RequestAuthManager;

    private readonly accessPolicy: ToolAccessPolicy;

    private readonly request: RequestHandler;

    private readonly siteOps: SiteOperations;

    private readonly deviceOps: DeviceOperations;

    private readonly clientOps: ClientOperations;

    private readonly securityOps: SecurityOperations;

    private readonly networkOps: NetworkOperations;
    private readonly networkDiagnosticsOps: NetworkDiagnosticsOperations;
    private readonly rateLimitProfileOps: RateLimitProfileOperations;
    private readonly networkChangeOps: NetworkChangeOperations;

    private readonly diagnosticsOps: DiagnosticsOperations;

    private readonly wifiAuditOps: WifiAuditOperations;

    private readonly dhcpReservationOps: DhcpReservationOperations;

    private readonly monitoringOps: MonitoringOperations;

    private readonly monitorOps: MonitorOperations;

    private readonly actionOps: ActionOperations;

    private readonly genericOps: GenericOperations;

    private readonly discoveryOps: DiscoveryOperations;

    private readonly capabilityOps: ControllerCapabilityOperations;

    private readonly switchOps: SwitchOperations;

    private readonly logNotificationOps: LogNotificationOperations;

    private readonly apSsidOverrideOps: ApSsidOverrideOperations;
    private readonly rfPlanningOps: RfPlanningOperations;

    private readonly apRadioOps: ApRadioOperations;

    private readonly omadacId: string;

    constructor(options: OmadaClientOptions) {
        this.omadacId = options.omadacId;
        this.accessPolicy = new ToolAccessPolicy(options.toolProfile, options.toolCategories);

        this.http = axios.create(createControllerHttpOptions(options));

        // Initialize operation modules
        this.auth =
            options.authMode === 'web'
                ? new WebAuthManager(this.http, options.webUsername ?? '', options.webPassword ?? '', options.omadacId)
                : new AuthManager(this.http, options.clientId ?? '', options.clientSecret ?? '', options.authId ?? options.omadacId);
        this.request = new RequestHandler(this.http, this.auth);
        this.siteOps = new SiteOperations(this.request, this.buildOmadaPath.bind(this), options.siteId);
        this.deviceOps = new DeviceOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.clientOps = new ClientOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.securityOps = new SecurityOperations(this.request, this.buildOmadaPath.bind(this));
        this.networkOps = new NetworkOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this), options.omadacId);
        this.networkDiagnosticsOps = new NetworkDiagnosticsOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.rateLimitProfileOps = new RateLimitProfileOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this), options.omadacId);
        this.dhcpReservationOps = new DhcpReservationOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this), options.omadacId);
        this.monitoringOps = new MonitoringOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.monitorOps = new MonitorOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.logNotificationOps = new LogNotificationOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.apSsidOverrideOps = new ApSsidOverrideOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.rfPlanningOps = new RfPlanningOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.apRadioOps = new ApRadioOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this), options.omadacId);
        this.networkChangeOps = new NetworkChangeOperations(
            options.omadacId,
            this.rateLimitProfileOps,
            this.networkOps,
            this.dhcpReservationOps,
            this.apRadioOps
        );
        this.actionOps = new ActionOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.genericOps = new GenericOperations(this.request, this.buildOmadaPath.bind(this), this.accessPolicy);
        this.discoveryOps = new DiscoveryOperations(this.request, this.http, options);
        this.capabilityOps = new ControllerCapabilityOperations(this.http, this.discoveryOps, options, this);
        this.switchOps = new SwitchOperations(this.request, this.siteOps, this.buildOmadaPath.bind(this));
        this.diagnosticsOps = new DiagnosticsOperations(this);
        this.wifiAuditOps = new WifiAuditOperations(this, { omadacId: options.omadacId, siteId: options.siteId });

        // Initialize internal API support if web credentials are configured
        if (options.webUsername && options.webPassword) {
            const internalAuth = new InternalAuthManager(this.http, options.webUsername, options.webPassword, options.omadacId);
            const internalReq = new InternalRequestHandler(this.http, internalAuth, options.omadacId);
            this.apSsidOverrideOps.setInternalRequest(internalReq);
            this.networkOps.setInternalRequest(internalReq);
            this.monitoringOps.setInternalRequest(internalReq);
            logger.info('Internal web UI API enabled for ACL management');
        }
        return createClientPolicyProxy(this, this.accessPolicy);
    }

    public async getApSsidOverrides(apMac: string, siteId?: string): Promise<unknown> {
        return await this.apSsidOverrideOps.getApSsidOverrides(apMac, siteId);
    }
    public async getRfPlanningStatus(options: GetRfPlanningOptions = {}) {
        return await this.rfPlanningOps.getRfPlanningStatus(options);
    }

    public async updateApSsidOverride(
        apMac: string,
        ssidEntryId: number,
        settings: ApSsidOverrideUpdate,
        siteId?: string,
        dryRun = true
    ): Promise<unknown> {
        return await this.apSsidOverrideOps.updateApSsidOverride(apMac, ssidEntryId, settings, siteId, dryRun);
    }

    public getToolAccessPolicy(): ToolAccessPolicy {
        return this.accessPolicy;
    }

    // Site operations
    public async listSites(): Promise<OmadaSiteSummary[]> {
        return await this.siteOps.listSites();
    }

    public async getControllerCapabilities(options: GetControllerCapabilitiesOptions = {}): Promise<ControllerCapabilitiesResult> {
        return await this.capabilityOps.getControllerCapabilities(options);
    }

    public async diagnoseWifi(options: GetWifiAuditOptions = {}): Promise<WifiAuditResult> {
        return await this.wifiAuditOps.diagnoseWifi(options);
    }

    public async getSiteDashboard(options: SiteDashboardOptions = {}): Promise<SiteDashboardResult> {
        return await this.monitorOps.getSiteDashboard(options);
    }

    // Device operations
    public async listDevices(siteId?: string, readOptions?: PaginationReadOptions): Promise<OmadaDeviceInfo[]> {
        return readOptions === undefined ? await this.deviceOps.listDevices(siteId) : await this.deviceOps.listDevices(siteId, readOptions);
    }

    public async getDevice(identifier: string, siteId?: string): Promise<OmadaDeviceInfo | undefined> {
        return await this.deviceOps.getDevice(identifier, siteId);
    }

    public async getGatewayWanStatus(gatewayMac: string, siteId?: string): Promise<GatewayWanStatus[]> {
        return await this.deviceOps.getGatewayWanStatus(gatewayMac, siteId);
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

    public async getSiteTopology(siteId?: string): Promise<unknown> {
        return await this.monitoringOps.getSiteTopology(siteId);
    }

    public async listVpnConnections(options: ListVpnConnectionsOptions = {}): Promise<unknown[]> {
        return await this.monitoringOps.listVpnConnections(options);
    }

    public async getGatewayWanSpeedTestResults(gatewayMac: string, siteId?: string): Promise<unknown> {
        return await this.monitoringOps.getGatewayWanSpeedTestResults(gatewayMac, siteId);
    }

    public async diagnoseClient(clientMac: string, siteId?: string, timeStart?: number, timeEnd?: number): Promise<DiagnoseClientResult> {
        return await this.diagnosticsOps.diagnoseClient(clientMac, siteId, timeStart, timeEnd);
    }

    public async diagnoseLogs(siteId?: string, timeStart?: number, timeEnd?: number, pageSize?: number): Promise<DiagnoseLogsResult> {
        return await this.diagnosticsOps.diagnoseLogs(siteId, timeStart, timeEnd, pageSize);
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

    public async getIpsSetting(siteId?: string): Promise<unknown> {
        return await this.networkOps.getIpsSetting(siteId);
    }

    public async listDhcpReservations(siteId?: string, searchKey?: string): Promise<DhcpReservation[]> {
        return await this.dhcpReservationOps.listDhcpReservations(siteId, searchKey);
    }

    public async createDhcpReservation(reservation: DhcpReservationConfig, siteId?: string, dryRun?: boolean): Promise<DhcpReservationWriteResult> {
        return await this.dhcpReservationOps.createDhcpReservation(reservation, siteId, dryRun);
    }

    public async updateDhcpReservation(
        mac: string,
        settings: DhcpReservationUpdate,
        siteId?: string,
        dryRun?: boolean
    ): Promise<DhcpReservationWriteResult> {
        return await this.dhcpReservationOps.updateDhcpReservation(mac, settings, siteId, dryRun);
    }

    public async deleteDhcpReservation(mac: string, siteId?: string, dryRun?: boolean): Promise<DhcpReservationWriteResult> {
        return await this.dhcpReservationOps.deleteDhcpReservation(mac, siteId, dryRun);
    }

    // Network write operations
    public async updateSsid(wlanId: string, ssidId: string, data: Record<string, unknown>, siteId?: string, dryRun = false): Promise<unknown> {
        return await this.networkOps.updateSsid(wlanId, ssidId, data, siteId, dryRun);
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

    public async setIpsSetting(data: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.setIpsSetting(data, siteId);
    }

    public async updateWanPortSetting(portSetting: Record<string, unknown>, siteId?: string): Promise<unknown> {
        return await this.networkOps.updateWanPortSetting(portSetting, siteId);
    }

    public async listEvents(
        siteId?: string,
        page?: number,
        pageSize?: number,
        timeStart?: number,
        timeEnd?: number,
        module?: 'System' | 'Device' | 'Client',
        keyPrefix?: string,
        excludeKeyPrefix?: string
    ): Promise<PaginatedResult<unknown> & { scanTruncated?: boolean }> {
        return await this.networkOps.listEvents(siteId, page, pageSize, timeStart, timeEnd, module, keyPrefix, excludeKeyPrefix);
    }

    public async listAlerts(
        siteId?: string,
        page?: number,
        pageSize?: number,
        timeStart?: number,
        timeEnd?: number,
        module?: 'System' | 'Device' | 'Client',
        resolved?: boolean
    ): Promise<PaginatedResult<unknown>> {
        return await this.networkOps.listAlerts(siteId, page, pageSize, timeStart, timeEnd, module, resolved);
    }

    public async listLogs(siteId?: string, page?: number, pageSize?: number): Promise<PaginatedResult<unknown>> {
        return await this.networkOps.listLogs(siteId, page, pageSize);
    }

    public async getApRadios(apMac: string, siteId?: string): Promise<{ radioConfig: unknown; radioStats: unknown }> {
        return await this.deviceOps.getApRadios(apMac, siteId);
    }

    public async getApRfScanResults(apMac: string, siteId?: string): Promise<unknown> {
        return await this.deviceOps.getApRfScanResults(apMac, siteId);
    }

    public async getApAfcStatus(apMac: string, siteId?: string): Promise<unknown> {
        return await this.deviceOps.getApAfcStatus(apMac, siteId);
    }

    public async getApAvailableChannels(apMac: string, siteId?: string): Promise<unknown> {
        return await this.deviceOps.getApAvailableChannels(apMac, siteId);
    }

    public async getClientHistory(options: GetClientHistoryOptions): Promise<ClientHistory> {
        return await this.clientOps.getClientHistory(options);
    }

    // Device and client actions
    public async rebootDevice(deviceMac: string, siteId?: string): Promise<unknown> {
        return await this.actionOps.rebootDevice(deviceMac, siteId);
    }

    public async adoptDevice(deviceMac: string, siteId?: string, credentials?: { username?: string; password?: string }): Promise<unknown> {
        return await this.actionOps.adoptDevice(deviceMac, siteId, credentials);
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

    public async updateClient(clientMac: string, data: Record<string, unknown>, siteId?: string, dryRun?: boolean): Promise<unknown> {
        return await this.actionOps.updateClient(clientMac, data, siteId, dryRun);
    }

    public async setDeviceLed(deviceMac: string, ledSetting: number, siteId?: string): Promise<unknown> {
        return await this.actionOps.setDeviceLed(deviceMac, ledSetting, siteId);
    }

    public async locateDevice(deviceMac: string, enable: boolean, siteId?: string): Promise<unknown> {
        return await this.actionOps.locateDevice(deviceMac, enable, siteId);
    }

    public async setSiteLed(enable: boolean, siteId?: string): Promise<unknown> {
        return await this.actionOps.setSiteLed(enable, siteId);
    }

    public async setApRadio(
        apMac: string,
        band: ApRadioBand,
        settings: ApRadioSettings,
        siteId?: string,
        dryRun?: boolean
    ): Promise<SetApRadioResult> {
        return await this.apRadioOps.setApRadio(apMac, band, settings, siteId, dryRun);
    }

    public async setLogNotifications(options: SetLogNotificationsOptions): Promise<SetLogNotificationsResult> {
        return await this.logNotificationOps.setLogNotifications(options);
    }

    public async getFirmwareDetails(deviceMac: string, siteId?: string): Promise<unknown> {
        return await this.actionOps.getFirmwareDetails(deviceMac, siteId);
    }

    public async startFirmwareUpgrade(deviceMac: string, siteId?: string): Promise<unknown> {
        return await this.actionOps.startFirmwareUpgrade(deviceMac, siteId);
    }

    public async setGatewayWanConnect(gatewayMac: string, portId: number, action: 'connect' | 'disconnect', siteId?: string): Promise<unknown> {
        return await this.actionOps.setGatewayWanConnect(gatewayMac, portId, action, siteId);
    }

    // Network read/write operations (switch ports, firewall ACLs, routes)
    public async updateSwitchPort(
        switchMac: string,
        portId: string,
        data: Record<string, unknown>,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<unknown> {
        return await this.switchOps.updateSwitchPort(switchMac, portId, data, siteId, options);
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

    public async listSwitchPorts(switchMac?: string, siteId?: string): Promise<Record<string, unknown>[]> {
        return await this.switchOps.listSwitchPorts(switchMac, siteId);
    }

    public async setSwitchPortProfile(
        switchMac: string,
        port: number,
        profileId: string,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<unknown> {
        return await this.switchOps.setSwitchPortProfile(switchMac, port, profileId, siteId, options);
    }

    public async setSwitchPortPoe(switchMac: string, port: number, poeMode: number, siteId?: string, options?: SwitchWriteOptions): Promise<unknown> {
        return await this.switchOps.setSwitchPortPoe(switchMac, port, poeMode, siteId, options);
    }

    public async setSwitchPortName(switchMac: string, port: number, name: string, siteId?: string, options?: SwitchWriteOptions): Promise<unknown> {
        return await this.switchOps.setSwitchPortName(switchMac, port, name, siteId, options);
    }

    public async setSwitchPortStatus(
        switchMac: string,
        port: number,
        status: number,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<unknown> {
        return await this.switchOps.setSwitchPortStatus(switchMac, port, status, siteId, options);
    }

    public async setSwitchPortProfileOverride(
        switchMac: string,
        port: number,
        profileOverrideEnable: boolean,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<unknown> {
        return await this.switchOps.setSwitchPortProfileOverride(switchMac, port, profileOverrideEnable, siteId, options);
    }

    public async batchSetSwitchPortProfile(
        switchMac: string,
        portList: number[],
        profileOverrideEnable: boolean,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<unknown> {
        return await this.switchOps.batchSetSwitchPortProfile(switchMac, portList, profileOverrideEnable, siteId, options);
    }

    public async batchSetSwitchPortPoe(
        switchMac: string,
        portList: number[],
        poeMode: number,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<unknown> {
        return await this.switchOps.batchSetSwitchPortPoe(switchMac, portList, poeMode, siteId, options);
    }

    public async batchSetSwitchPortStatus(
        switchMac: string,
        portList: number[],
        status: number,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<unknown> {
        return await this.switchOps.batchSetSwitchPortStatus(switchMac, portList, status, siteId, options);
    }

    public async batchSetSwitchPortName(
        switchMac: string,
        portNameList: Array<{ port: number; name: string }>,
        siteId?: string,
        options?: SwitchWriteOptions
    ): Promise<unknown> {
        return await this.switchOps.batchSetSwitchPortName(switchMac, portNameList, siteId, options);
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
    public async getTrafficHistory(options: NetworkDiagnosticOptions = {}): Promise<NetworkDiagnosticsResult> {
        return await this.networkDiagnosticsOps.getTrafficHistory(options);
    }
    public async getWifiHistory(options: WifiHistoryOptions = {}): Promise<NetworkDiagnosticsResult> {
        return await this.networkDiagnosticsOps.getWifiHistory(options);
    }
    public async diagnoseWan(options: WanDiagnosticOptions): Promise<NetworkDiagnosticsResult> {
        return await this.networkDiagnosticsOps.diagnoseWan(options);
    }
    public async updateRateLimitProfile(
        profileId: string,
        settings: RateLimitProfileUpdate,
        siteId?: string,
        dryRun = true
    ): Promise<RateLimitProfileWriteResult> {
        return await this.rateLimitProfileOps.updateRateLimitProfile(profileId, settings, siteId, dryRun);
    }
    public async rollbackNetworkChange(receipt: NetworkChangeReceipt, dryRun = true): Promise<unknown> {
        return await this.networkChangeOps.rollbackNetworkChange(receipt, dryRun);
    }
    public async refreshApiCatalog(): Promise<unknown> {
        return await this.discoveryOps.refreshApiCatalog();
    }

    public async searchApiOperations(options: SearchApiOperationsOptions = {}, policy: DiscoveryPolicy = {}): Promise<unknown> {
        return await this.discoveryOps.searchApiOperations(options, policy);
    }

    public async describeApiOperation(operationId: string, policy: DiscoveryPolicy = {}): Promise<unknown> {
        return await this.discoveryOps.describeApiOperation(operationId, policy);
    }

    public async executeApiOperation(options: ExecuteApiOperationOptions, policy: DiscoveryPolicy = {}): Promise<unknown> {
        return await this.discoveryOps.executeApiOperation(options, policy);
    }

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
