import type { ToolProfile } from '../config.js';

export const TOOL_CATEGORIES = [
    'system',
    'devices',
    'clients',
    'wireless',
    'switching',
    'network',
    'security',
    'monitoring',
    'maintenance',
    'msp',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];
type Permission = 'r' | 'w' | 'rw';

const groups: Record<ToolCategory, readonly string[]> = {
    system: ['listSites', 'getServerInfo', 'getControllerCapabilities'],
    devices: [
        'listDevices',
        'getDevice',
        'searchDevices',
        'listDevicesStats',
        'getDevicesStats',
        'adoptDevice',
        'rebootDevice',
        'setDeviceLed',
        'locateDevice',
    ],
    clients: [
        'listClients',
        'getClient',
        'listMostActiveClients',
        'listClientsActivity',
        'listClientsPastConnections',
        'getClientHistory',
        'updateClient',
        'updateRateLimitProfile',
        'rollbackNetworkChange',
        'blockClient',
        'unblockClient',
        'reconnectClient',
    ],
    wireless: [
        'getRfPlanningStatus',
        'getApSsidOverrides',
        'updateApSsidOverride',
        'getApRadios',
        'getApRfScanResults',
        'getApAfcStatus',
        'getApAvailableChannels',
        'getWlanGroupList',
        'getSsidList',
        'getSsidDetail',
        'updateSsid',
        'setSsidEnable',
        'setApRadio',
        'diagnoseWifi',
        'getWifiHistory',
    ],
    switching: [
        'getSwitchPortOverview',
        'getSwitch',
        'listSwitchPorts',
        'getSwitchStackDetail',
        'getCableTestResults',
        'getSwitchNetworks',
        'updateSwitchPort',
        'setSwitchNetworks',
        'setSwitchPortProfile',
        'setSwitchPortPoe',
        'setSwitchPortName',
        'setSwitchPortStatus',
        'setSwitchPortProfileOverride',
        'batchSetSwitchPortProfile',
        'batchSetSwitchPortPoe',
        'batchSetSwitchPortStatus',
        'batchSetSwitchPortName',
        'startCableTest',
        'getLanProfileList',
        'createLanProfile',
        'updateLanProfile',
    ],
    network: [
        'getGatewayWanStatus',
        'diagnoseWan',
        'getInternetInfo',
        'getLanNetworkList',
        'getPortForwardingStatus',
        'listDhcpReservations',
        'createDhcpReservation',
        'updateDhcpReservation',
        'deleteDhcpReservation',
        'createLanNetwork',
        'updateLanNetwork',
        'deleteLanNetwork',
        'listRoutes',
        'createRoute',
        'updateRoute',
        'deleteRoute',
        'createPortForward',
        'updatePortForward',
        'deletePortForward',
        'updateWanPortSetting',
        'setGatewayWanConnect',
    ],
    security: [
        'getThreatList',
        'getFirewallSetting',
        'getIpsSetting',
        'listFirewallAcls',
        'listIpGroups',
        'updateFirewallSetting',
        'setIpsSetting',
        'createFirewallAcl',
        'updateFirewallAcl',
        'deleteFirewallAcl',
        'listVpnConnections',
    ],
    monitoring: [
        'getSiteTopology',
        'getSiteDashboard',
        'getTrafficHistory',
        'diagnoseClient',
        'diagnoseLogs',
        'getGatewayWanSpeedTestResults',
        'listAlerts',
        'listEvents',
        'listLogs',
        'setLogNotifications',
    ],
    maintenance: ['getFirmwareDetails', 'startFirmwareUpgrade', 'setSiteLed'],
    msp: [],
};

const toolCategories = new Map(Object.entries(groups).flatMap(([category, names]) => names.map((name) => [name, category as ToolCategory] as const)));
const discoveryTools = new Set(['searchApiOperations', 'describeApiOperation', 'executeApiOperation', 'refreshApiCatalog']);
const statusTools = new Set(['getServerInfo', 'getControllerCapabilities']);
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Category entries override the all: fallback; duplicate/empty entries never broaden access. */
export function parseToolCategories(value: string | undefined): ReadonlyMap<string, Permission> | undefined {
    if (value === undefined) return undefined;
    if (!value.trim() || value.length > 1024) throw new Error('MCP_TOOL_CATEGORIES requires category:r, category:w or category:rw entries.');
    const permissions = new Map<string, Permission>();
    for (const entry of value.split(',')) {
        const match = /^([a-z]+):(r|w|rw)$/.exec(entry.trim());
        if (!match || (match[1] !== 'all' && !TOOL_CATEGORIES.includes(match[1] as ToolCategory)) || permissions.has(match[1])) {
            throw new Error('Invalid or duplicate MCP_TOOL_CATEGORIES entry. Use known categories with :r, :w or :rw.');
        }
        permissions.set(match[1], match[2] as Permission);
    }
    return permissions;
}

/** Classify canonical route ownership, never vendor tags or prose. Unknown families stay denied. */
export function categoryForPath(path: string): ToolCategory | undefined {
    const msp = /^\/openapi\/v[12]\/msp\/\{mspId\}(?=\/)/.test(path);
    let route = path.replace(/^\/openapi\/v[12]\/(?:\{omadacId\}|msp\/\{mspId\})/, '');
    if (!route.startsWith('/') || /[?%#\\]/.test(route) || route.includes('//') || route.split('/').some((part) => part === '.' || part === '..'))
        return undefined;
    // MSP authority spans customers and account administration; controller categories cannot grant it implicitly.
    if (msp) return 'msp';
    if (route === '/sites') return 'system';
    const site = /^\/sites\/[^/]+(?:\/(.*))?$/.exec(route);
    if (site) route = `/${site[1] ?? ''}`;
    if (/^\/gateways\/[^/]+\/config\/advanced(?:\/|$)/.test(route)) return undefined;
    if (/^\/gateways\/[^/]+\/config\/(?:wlans|radios)(?:\/|$)/.test(route)) return 'wireless';
    if (
        /^\/multi-devices\/(?:start-rolling-upgrade|start-manually-upgrade|rolling-upgrade-tasks|manually-upgrade-tasks)(?:\/|$)/.test(route) ||
        /^\/devices\/upgrade-file$/.test(route) ||
        /^\/all-devices\/(?:start-check-latest-firmware|check-latest-firmware-tasks)(?:\/|$)/.test(route) ||
        /^\/logs\/[^/]+\/upgrade(?:\/|$)/.test(route)
    )
        return 'maintenance';
    if (
        /^\/(?:devices|aps|switches|gateways)\/[^/]+\/(?:latest-firmware-info|firmware|upgrade|start-online-upgrade)(?:\/|$)/.test(route) ||
        /^\/(?:backup|restore|maintenance|upgrade-schedules|reboot-schedules)(?:\/|$)/.test(route)
    )
        return 'maintenance';
    if (/\/gateways\/[^/]+\/speedTestResult$/.test(route)) return 'monitoring';
    if (/^\/dashboard\/(?:active-clients|client-activity)(?:\/|$)/.test(route) || /^\/insight\/past-connection(?:\/|$)/.test(route)) return 'clients';
    if (/^\/insight\/port-forwarding(?:\/|$)/.test(route)) return 'network';
    if (
        /^\/(?:wireless-network|aps|rfPlanning|rfplanning|planningHistory|rogue-ap|full-channel-detect|roaming|mesh|beacon-control|band-steering|ppsk-profiles?)(?:\/|$)/.test(
            route
        )
    )
        return 'wireless';
    if (/^\/setting\/(?:wlan|wireless|radio|iot)(?:\/|$)/.test(route)) return 'wireless';
    if (/^\/(?:rate-limit-profiles?|clients|monitor-client)(?:\/|$)/.test(route)) return 'clients';
    if (
        /^\/(?:switches|stacks?|cable-test|lan-profiles|poe-ports|port-status-ports|switch-support|switch-oui-rules|lan-switch-setting)(?:\/|$)/.test(
            route
        )
    )
        return 'switching';
    if (
        /^\/(?:security|acls|firewall|ips|network-security|attack-defense|url-filters|ip-mac-binds?|dot1x|mac-auth|vpn)(?:\/|$)/.test(route) ||
        /^\/setting\/(?:vpn|firewall|security|ips|acl)(?:\/|$)/.test(route)
    )
        return 'security';
    if (
        /^\/(?:dashboard|global-dashboard|logs|audit-logs|topology|health|insight|stat|experienceIndex|networkReport)(?:\/|$)/.test(route) ||
        /^\/site\/log-notification$/.test(route)
    )
        return 'monitoring';
    if (
        /^\/(?:internet|lan-networks|lan-vlans|wired-networks|wan|nat|routing|qos|ospf|bandwidth-control|ip-mac-bind|upnp|gateways|vlan-interface|wan-lan-status|wan-max-speed)(?:\/|$)/.test(
            route
        ) ||
        /^\/setting\/(?:service|lan|wan|routing|network)(?:\/|$)/.test(route)
    )
        return 'network';
    if (/^\/(?:devices|multi-devices|all-devices|monitor-device)(?:\/|$)/.test(route)) return 'devices';
    if (/^\/cmd\/(?:devices|adopt|reconnect)(?:\/|$)/.test(route)) return 'devices';
    if (/^\/cmd\/switches(?:\/|$)/.test(route)) return 'switching';
    if (/^\/cmd\/(?:rfPlanning|aps)(?:\/|$)/.test(route)) return 'wireless';
    if (/^\/cmd\/clients(?:\/|$)/.test(route)) return 'clients';
    if (/^\/(?:led|cmd\/led)(?:\/|$)/.test(route)) return 'maintenance';
    return undefined;
}

export class ToolAccessPolicy {
    public readonly readOnly: boolean;
    public readonly scoped: boolean;
    private readonly permissions: ReadonlyMap<string, Permission> | undefined;

    constructor(
        profile: ToolProfile = 'full',
        categories?: string,
        private readonly parents: readonly ToolAccessPolicy[] = []
    ) {
        if (profile !== 'full' && profile !== 'read-only') throw new Error('Unknown MCP tool profile.');
        this.permissions = parseToolCategories(categories);
        this.readOnly = profile === 'read-only' || parents.some((policy) => policy.readOnly);
        this.scoped = categories !== undefined || parents.some((policy) => policy.scoped);
    }

    public intersect(other: ToolAccessPolicy): ToolAccessPolicy {
        return new ToolAccessPolicy('full', undefined, [this, other]);
    }

    public get unrestricted(): boolean {
        return !this.readOnly && !this.scoped;
    }
    public get permitsWrites(): boolean {
        return TOOL_CATEGORIES.some((category) => this.allowsCategory(category, true));
    }

    public allowsCategory(category: ToolCategory | undefined, write: boolean): boolean {
        if (write && this.readOnly) return false;
        if (this.parents.some((parent) => !parent.allowsCategory(category, write))) return false;
        if (!this.permissions) return category !== undefined || !this.scoped;
        if (category === undefined) return false;
        const permission = this.permissions.get(category) ?? this.permissions.get('all');
        return permission !== undefined && permission.includes(write ? 'w' : 'r');
    }

    public allowsTool(name: string, destructive = false): boolean {
        if (name === 'diagnoseNetwork')
            return (['devices', 'clients', 'wireless', 'switching', 'network', 'monitoring'] as const).every((category) =>
                this.allowsCategory(category, false)
            );
        if (name === 'rollbackNetworkChange')
            return ['clients', 'network', 'wireless'].some((category) => this.allowsCategory(category as ToolCategory, true));
        if (statusTools.has(name) || discoveryTools.has(name)) return true;
        if (name === 'genericApiCall')
            return (
                !this.readOnly &&
                (this.unrestricted || TOOL_CATEGORIES.some((category) => this.allowsCategory(category, false) || this.allowsCategory(category, true)))
            );
        const write = destructive || !/^(get|list|search|diagnose)[A-Z]/.test(name);
        const category = toolCategories.get(name);
        return this.unrestricted || this.allowsCategory(category, write);
    }

    public assertTool(name: string, args?: unknown, destructive = false): void {
        if (name === 'rollbackNetworkChange' && args !== undefined) {
            const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : undefined;
            const receipt = input && Object.hasOwn(input, 'receipt') ? input.receipt : input;
            const resource = receipt && typeof receipt === 'object' ? (receipt as Record<string, unknown>).resource : undefined;
            const categories: Record<string, ToolCategory> = {
                'rate-limit-profile': 'clients',
                'dhcp-reservation': 'network',
                'ssid-basic': 'wireless',
                'ap-radio': 'wireless',
            };
            if (typeof resource !== 'string' || !this.allowsCategory(categories[resource], true))
                throw new Error('Rollback resource is not permitted by the configured tool policy.');
        }
        if (!this.allowsTool(name, destructive)) throw new Error(`Tool ${name} is not permitted by the configured tool policy.`);
        if (
            name === 'getControllerCapabilities' &&
            args &&
            typeof args === 'object' &&
            ('wlanId' in args || 'ssidId' in args) &&
            !this.allowsCategory('wireless', false)
        ) {
            throw new Error('Wireless read permission is required for SSID capability evidence.');
        }
    }

    public allowsOperation(method: string, path: string): boolean {
        if (!methods.has(method)) return false;
        if (this.unrestricted) return true;
        return this.allowsCategory(categoryForPath(path), method !== 'GET');
    }

    public assertOperation(method: string, path: string): void {
        if (!this.allowsOperation(method, path)) throw new Error('API operation is not permitted by the configured tool policy.');
    }

    public assertGeneric(method: string, path: string, version: string, query?: Record<string, unknown>): void {
        if (this.unrestricted) return;
        if (
            !methods.has(method) ||
            !['v1', 'v2'].includes(version) ||
            path.startsWith('/openapi') ||
            !/^\/(?:[A-Za-z0-9_.:{}-]+\/?)+$/.test(path) ||
            /[%?#\\]/.test(path) ||
            path.includes('//') ||
            path.split('/').some((part) => part === '.' || part === '..')
        ) {
            throw new Error('Scoped generic calls require a canonical relative Open API path and supported method/version.');
        }
        if (query && Object.keys(query).some((key) => /^(?:omadacId|mspId)$/i.test(key)))
            throw new Error('Controller identifiers cannot be overridden by generic query parameters.');
        this.assertOperation(method, path);
    }
}

/** Bind the original instance so composed diagnostics/preflights retain their internal dependencies. */
export function createClientPolicyProxy<T extends object>(client: T, policy: ToolAccessPolicy): T {
    if (policy.unrestricted) return client;
    return new Proxy(client, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== 'function' || typeof property !== 'string' || property === 'getToolAccessPolicy')
                return typeof value === 'function' ? value.bind(target) : value;
            return async (...args: unknown[]) => {
                policy.assertTool(property, args[0]);
                if (property === 'genericApiCall')
                    policy.assertGeneric(String(args[0]), String(args[1]), String(args[2] ?? 'v1'), args[4] as Record<string, unknown> | undefined);
                return await Reflect.apply(value, target, args);
            };
        },
    });
}
