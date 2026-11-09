import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import axios, { type AxiosInstance } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfigFromEnv } from '../../src/config.js';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { executeDiscoveredOperation } from '../../src/discovery/execute.js';
import { CatalogLoader } from '../../src/discovery/load.js';
import { DiscoveryOperations } from '../../src/omadaClient/discovery.js';
import { GenericOperations } from '../../src/omadaClient/generic.js';
import { OmadaClient } from '../../src/omadaClient/index.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import { createServer } from '../../src/server/common.js';
import { categoryForPath, createClientPolicyProxy, parseToolCategories, ToolAccessPolicy } from '../../src/server/toolPolicy.js';
import { toolRegistrationServer } from '../../src/server/toolProfile.js';
import { registerAllTools } from '../../src/tools/index.js';

const PREFIX = '/openapi/v1/{omadacId}/sites/{siteId}';
const doc = {
    openapi: '3.0.1',
    paths: {
        [`${PREFIX}/wireless-network/ssids`]: { get: { operationId: 'wifiRead' }, post: { operationId: 'wifiWrite' } },
        [`${PREFIX}/rate-limit-profiles`]: { get: { operationId: 'clientRead' }, post: { operationId: 'clientWrite' } },
        [`${PREFIX}/mystery`]: { get: { operationId: 'unknownRead' } },
    },
};

function discovery(config: { toolProfile?: 'full' | 'read-only'; toolCategories?: string } = {}) {
    const request = { request: vi.fn().mockResolvedValue({ errorCode: 0, result: {} }), ensureSuccess: vi.fn((reply) => reply.result) };
    const service = new DiscoveryOperations(
        request as unknown as RequestHandler,
        {} as AxiosInstance,
        { omadacId: 'controller', siteId: 'site', ...config },
        new CatalogLoader(async () => doc, 'auto')
    );
    return { service, request };
}

describe('scoped tool policy', () => {
    afterEach(() => vi.restoreAllMocks());
    it.each(['', ' ', ',', 'wireles:rw', 'wireless', 'wireless:all', 'wireless:r,wireless:rw', 'all:rw,', 'all:R'])(
        'fails closed on invalid category policy %j',
        (value) => {
            expect(() => parseToolCategories(value)).toThrow();
        }
    );

    it('uses category overrides and intersects rather than weakening policies', () => {
        expect(() => new ToolAccessPolicy('admin' as never)).toThrow('Unknown MCP tool profile');
        const policy = new ToolAccessPolicy('full', 'all:rw,wireless:r');
        expect(policy.allowsCategory('wireless', false)).toBe(true);
        expect(policy.allowsCategory('wireless', true)).toBe(false);
        expect(policy.allowsCategory('clients', true)).toBe(true);
        expect(policy.intersect(new ToolAccessPolicy('read-only')).allowsCategory('clients', true)).toBe(false);
        expect(new ToolAccessPolicy('full', 'wireless:w').allowsCategory('wireless', false)).toBe(false);
    });

    it('classifies dedicated tools exhaustively while leaving unknown names denied', () => {
        const names: Array<{ name: string; destructive: boolean }> = [];
        registerAllTools(
            {
                registerTool: (name: string, config: { annotations?: { destructiveHint?: boolean } }) =>
                    names.push({ name, destructive: config.annotations?.destructiveHint === true }),
            } as never,
            {} as never
        );
        const policy = new ToolAccessPolicy('full', 'all:rw');
        for (const { name, destructive } of names) expect(policy.allowsTool(name, destructive), name).toBe(true);
        expect(policy.allowsTool('getUnknownOperation')).toBe(false);
        expect(policy.allowsTool('setUnknownOperation')).toBe(false);
    });

    it('keeps firmware, telemetry, client profiles and wireless route ownership explicit', () => {
        expect(categoryForPath(`${PREFIX}/devices/{mac}/start-online-upgrade`)).toBe('maintenance');
        expect(categoryForPath(`${PREFIX}/gateways/{mac}/speedTestResult`)).toBe('monitoring');
        expect(categoryForPath(`${PREFIX}/rate-limit-profile/{profileId}`)).toBe('clients');
        expect(categoryForPath(`${PREFIX}/wireless-network/wlans`)).toBe('wireless');
        expect(categoryForPath(`${PREFIX}/unknown-setting`)).toBeUndefined();
        expect(categoryForPath(`${PREFIX}/clients/backup/name`)).toBe('clients');
        expect(categoryForPath(`${PREFIX}/wireless-network/wlans/upgrade/ssids/name`)).toBe('wireless');
    });

    it.each([
        ['POST', '/multi-devices/start-rolling-upgrade'],
        ['POST', '/multi-devices/start-manually-upgrade'],
        ['DELETE', '/multi-devices/rolling-upgrade-tasks/task'],
        ['POST', '/devices/upgrade-file'],
        ['POST', '/all-devices/start-check-latest-firmware'],
    ])('keeps batch and upload firmware action %s %s in maintenance', (method, suffix) => {
        expect(categoryForPath(`${PREFIX}${suffix}`)).toBe('maintenance');
        expect(new ToolAccessPolicy('full', 'all:r,devices:rw').allowsOperation(method, `${PREFIX}${suffix}`)).toBe(false);
        expect(new ToolAccessPolicy('full', 'all:r,maintenance:rw').allowsOperation(method, `${PREFIX}${suffix}`)).toBe(true);
    });

    it('does not let monitoring writes trigger firmware rollback through upgrade logs', () => {
        const path = '/openapi/v1/{omadacId}/logs/log/upgrade/overview/rollback';
        expect(new ToolAccessPolicy('full', 'all:r,monitoring:rw').allowsOperation('POST', path)).toBe(false);
        expect(new ToolAccessPolicy('full', 'maintenance:rw').allowsOperation('POST', path)).toBe(true);
    });

    it('categorizes gateway wireless writes and denies mixed-domain advanced settings', () => {
        const network = new ToolAccessPolicy('full', 'all:r,network:rw');
        const wireless = new ToolAccessPolicy('full', 'all:r,wireless:rw');
        for (const endpoint of ['wlans', 'radios']) {
            const path = `${PREFIX}/gateways/mac/config/${endpoint}`;
            expect(network.allowsOperation('PUT', path)).toBe(false);
            expect(wireless.allowsOperation('PUT', path)).toBe(true);
        }
        expect(new ToolAccessPolicy('full', 'all:rw').allowsOperation('PUT', `${PREFIX}/gateways/mac/config/advanced`)).toBe(false);
    });

    it.each([
        ['startFirmwareUpgrade', 'POST', '/devices/mac/start-online-upgrade', 'maintenance'],
        ['rebootDevice', 'POST', '/devices/mac/reboot', 'devices'],
        ['adoptDevice', 'POST', '/devices/mac/start-adopt', 'devices'],
        ['locateDevice', 'PATCH', '/devices/mac/locate', 'devices'],
        ['setSiteLed', 'PATCH', '/led', 'maintenance'],
        ['setApRadio', 'PATCH', '/aps/mac/radio-config', 'wireless'],
        ['updateSsid', 'PATCH', '/wireless-network/wlans/w/ssids/s/update-basic-config', 'wireless'],
        ['setSsidEnable', 'PATCH', '/wireless-network/ssids/s/enable', 'wireless'],
        ['setSwitchPortPoe', 'PUT', '/switches/mac/ports/1/poe-mode', 'switching'],
        ['setSwitchPortProfile', 'PUT', '/switches/mac/ports/1/profile', 'switching'],
        ['createLanProfile', 'POST', '/lan-profiles', 'switching'],
        ['createLanNetwork', 'POST', '/lan-networks', 'network'],
        ['createDhcpReservation', 'POST', '/setting/service/dhcp', 'network'],
        ['setGatewayWanConnect', 'PATCH', '/gateways/mac/internet-state', 'network'],
        ['updateWanPortSetting', 'PATCH', '/wan/networks/port-setting', 'network'],
        ['createFirewallAcl', 'POST', '/acls/osg-acls', 'security'],
        ['updateFirewallSetting', 'PATCH', '/firewall', 'security'],
        ['setIpsSetting', 'PATCH', '/network-security/ips', 'security'],
        ['setLogNotifications', 'PATCH', '/site/log-notification', 'monitoring'],
        ['blockClient', 'POST', '/clients/mac/block', 'clients'],
        ['updateClient', 'PATCH', '/clients/mac/ratelimit', 'clients'],
        ['getThreatList', 'GET', '/security/threat-management', 'security', true],
        ['listMostActiveClients', 'GET', '/dashboard/active-clients', 'clients'],
        ['listClientsActivity', 'GET', '/dashboard/client-activity', 'clients'],
        ['listClientsPastConnections', 'GET', '/insight/past-connection', 'clients'],
        ['getPortForwardingStatus', 'GET', '/insight/port-forwarding/user', 'network'],
        ['getGatewayWanSpeedTestResults', 'GET', '/gateways/mac/speedTestResult', 'monitoring'],
    ])('keeps %s and its canonical API route in the same category', (name, method, suffix, category, global = false) => {
        const path = global ? `/openapi/v1/{omadacId}${suffix}` : `${PREFIX}${suffix}`;
        expect(categoryForPath(path)).toBe(category);
        const policy = new ToolAccessPolicy('full', `${category}:rw`);
        expect(policy.allowsTool(name)).toBe(true);
        expect(policy.allowsOperation(method, path)).toBe(true);
        const other = category === 'devices' ? 'maintenance' : 'devices';
        const denied = new ToolAccessPolicy('full', `${other}:rw`);
        expect(denied.allowsTool(name)).toBe(false);
        expect(denied.allowsOperation(method, path)).toBe(false);
    });

    it.each([
        ['getTrafficHistory', 'monitoring', false],
        ['getWifiHistory', 'wireless', false],
        ['diagnoseWan', 'network', false],
        ['updateRateLimitProfile', 'clients', true],
        ['rollbackNetworkChange', 'clients', true],
    ] as const)('keeps %s in its explicit workflow scope without broadening unrelated permissions', (name, category, write) => {
        const granted = new ToolAccessPolicy('full', `${category}:rw`);
        expect(granted.allowsTool(name)).toBe(true);
        const other = 'devices';
        expect(new ToolAccessPolicy('full', `${other}:rw`).allowsTool(name)).toBe(false);
        expect(new ToolAccessPolicy('full', `${category}:r`).allowsTool(name)).toBe(!write);
        if (write) expect(new ToolAccessPolicy('read-only', `${category}:rw`).allowsTool(name)).toBe(false);
    });

    it('aligns rate-profile discovery paths with update and rollback tool ownership', () => {
        for (const suffix of ['/rate-limit-profiles', '/rate-limit-profile/{profileId}']) {
            const path = `${PREFIX}${suffix}`;
            expect(categoryForPath(path)).toBe('clients');
            expect(new ToolAccessPolicy('full', 'clients:r').allowsOperation('GET', path)).toBe(true);
            expect(new ToolAccessPolicy('full', 'clients:r').allowsOperation('PUT', path)).toBe(false);
            expect(new ToolAccessPolicy('full', 'clients:rw').allowsOperation('PUT', path)).toBe(true);
            expect(new ToolAccessPolicy('full', 'network:rw').allowsOperation('PUT', path)).toBe(false);
        }
    });

    it('guards configured client methods and optional SSID evidence without blocking internal dependencies', async () => {
        let reads = 0;
        const raw = {
            listDevices: () => {
                reads++;
                return Promise.resolve([]);
            },
            diagnoseWifi: async function () {
                return await this.listDevices();
            },
            setApRadio: vi.fn().mockResolvedValue({}),
            setSwitchPortName: vi.fn(),
            callApi: vi.fn(),
            genericApiCall: vi.fn(),
            getControllerCapabilities: vi.fn().mockResolvedValue({}),
        };
        const client = createClientPolicyProxy(raw, new ToolAccessPolicy('full', 'wireless:r'));
        await client.diagnoseWifi();
        expect(reads).toBe(1);
        await expect(client.listDevices()).rejects.toThrow('not permitted');
        await expect(client.setApRadio()).rejects.toThrow('not permitted');
        await expect(client.callApi()).rejects.toThrow('not permitted');
        await expect(client.setSwitchPortName()).rejects.toThrow('not permitted');
        expect(raw.setApRadio).not.toHaveBeenCalled();
        expect(raw.callApi).not.toHaveBeenCalled();
        const system = createClientPolicyProxy(raw, new ToolAccessPolicy('full', 'system:r'));
        await system.getControllerCapabilities();
        await expect(system.getControllerCapabilities({ wlanId: 'wlan', ssidId: 'ssid' } as never)).rejects.toThrow('Wireless read');
    });

    it('enforces policy on the real client facade before raw HTTP or authentication', async () => {
        const http = axios.create();
        const request = vi.spyOn(http, 'request').mockRejectedValue(new Error('Unexpected resource request'));
        const post = vi.spyOn(http, 'post').mockRejectedValue(new Error('Unexpected authentication request'));
        vi.spyOn(axios, 'create').mockReturnValue(http);
        const client = new OmadaClient(
            loadConfigFromEnv({
                OMADA_BASE_URL: 'https://controller.invalid',
                OMADA_OMADAC_ID: 'controller',
                OMADA_CLIENT_ID: 'client',
                OMADA_CLIENT_SECRET: 'secret',
                MCP_TOOL_CATEGORIES: 'system:r',
            })
        );
        await expect(client.callApi({ method: 'POST', url: 'https://other.invalid/openapi/v1/other/sites' })).rejects.toThrow('not permitted');
        await expect(client.genericApiCall('POST', '/sites/site/rate-limit-profiles')).rejects.toThrow('not permitted');
        await expect(client.setSwitchPortName('AA-BB-CC-DD-EE-FF', 1, 'Name')).rejects.toThrow('not permitted');
        await expect(client.getControllerCapabilities({ wlanId: 'w', ssidId: 's' })).rejects.toThrow('Wireless read');
        expect(request).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it('filters discovery before pagination and rejects denied descriptions/execution/previews', async () => {
        const { service, request } = discovery({ toolCategories: 'all:r,wireless:rw' });
        const result = (await service.searchApiOperations({ limit: 50 })) as { operations: { operationId: string }[] };
        expect(result.operations.map((op) => op.operationId).sort()).toEqual(['clientRead', 'wifiRead', 'wifiWrite']);
        await expect(service.describeApiOperation('clientWrite')).rejects.toThrow('inaccessible');
        await expect(service.executeApiOperation({ operationId: 'clientWrite', dryRun: true })).rejects.toThrow('not permitted');
        await expect(service.executeApiOperation({ operationId: 'unknownRead' })).rejects.toThrow('not permitted');
        expect(request.request).not.toHaveBeenCalled();
        await expect(service.executeApiOperation({ operationId: 'wifiWrite', dryRun: false })).resolves.toMatchObject({ written: true });
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('cannot weaken configured scopes or read-only with per-server policy', async () => {
        const { service, request } = discovery({ toolProfile: 'read-only', toolCategories: 'all:rw' });
        await expect(
            service.executeApiOperation({ operationId: 'wifiWrite', dryRun: true }, { readOnly: false, accessPolicy: new ToolAccessPolicy() })
        ).rejects.toThrow('Read-only');
        const other = discovery({ toolCategories: 'clients:r' });
        await expect(
            other.service.executeApiOperation({ operationId: 'wifiWrite', dryRun: false }, { accessPolicy: new ToolAccessPolicy('full', 'all:rw') })
        ).rejects.toThrow('not permitted');
        expect(request.request).not.toHaveBeenCalled();
        expect(other.request.request).not.toHaveBeenCalled();
    });

    it('enforces scoped policy at the low-level discovery executor too', async () => {
        const request = { request: vi.fn() };
        await expect(
            executeDiscoveredOperation(
                new OperationCatalog(doc, 'live'),
                request as never,
                { operationId: 'clientWrite', dryRun: false },
                { omadacId: 'controller', siteId: 'site', readOnly: false, accessPolicy: new ToolAccessPolicy('full', 'wireless:rw') }
            )
        ).rejects.toThrow('not permitted');
        expect(request.request).not.toHaveBeenCalled();
    });

    it.each([
        'https://evil.invalid/sites/s/wireless-network',
        '//evil.invalid/x',
        '/sites/s/../wireless-network',
        '/sites/s/%2e%2e/wireless-network',
        '/sites/s/wireless-network?x=1',
        '/sites/s/wireless-network#x',
        '/sites//s/wireless-network',
        '/openapi/v1/another/sites/s/wireless-network',
        '/sites/s\\wireless-network',
    ])('rejects generic path bypass %s before HTTP', async (path) => {
        const request = { request: vi.fn() };
        const service = new GenericOperations(request as never, (value) => `/openapi/v1/controller${value}`, new ToolAccessPolicy('full', 'all:rw'));
        await expect(service.genericApiCall('POST', path)).rejects.toThrow();
        expect(request.request).not.toHaveBeenCalled();
    });

    it('checks generic method, category, version and controller query identity', async () => {
        const request = { request: vi.fn().mockResolvedValue({}) };
        const service = new GenericOperations(
            request as never,
            (value) => `/openapi/v1/controller${value}`,
            new ToolAccessPolicy('full', 'all:r,wireless:rw')
        );
        await expect(service.genericApiCall('DELETE', '/sites/s/rate-limit-profile/id')).rejects.toThrow('not permitted');
        await expect(service.genericApiCall('GET', '/sites/s/unknown')).rejects.toThrow('not permitted');
        await expect(service.genericApiCall('GET', '/sites/s/wireless-network', 'v3')).rejects.toThrow('canonical');
        await expect(service.genericApiCall('GET', '/sites/s/wireless-network', 'v1', undefined, { omadacId: 'other' })).rejects.toThrow(
            'overridden'
        );
        await service.genericApiCall('POST', '/sites/s/wireless-network');
        expect(request.request).toHaveBeenCalledTimes(1);
    });

    it('rechecks captured dedicated handlers rather than relying only on tools/list', async () => {
        let callback: ((args: unknown, extra: unknown) => Promise<unknown>) | undefined;
        const server = {
            registerTool: (_name: string, _config: unknown, handler: typeof callback) => {
                callback = handler;
            },
        };
        const guarded = toolRegistrationServer(server as never, 'full', new ToolAccessPolicy('full', 'system:r'));
        const underlying = vi.fn().mockResolvedValue({ content: [] });
        guarded.registerTool('getControllerCapabilities', {}, underlying);
        await expect(callback?.({ wlanId: 'w', ssidId: 's' }, {})).rejects.toThrow('Wireless read');
        expect(underlying).not.toHaveBeenCalled();
    });
});

describe('scoped MCP server isolation', () => {
    const cleanup: Array<() => Promise<void>> = [];
    afterEach(async () => {
        await Promise.all(cleanup.splice(0).map((close) => close()));
    });
    async function connect(api: object, categories: string) {
        const server = createServer(api as never, { toolCategories: categories });
        const client = new Client({ name: 'scoped-policy-test', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        cleanup.push(
            () => client.close(),
            () => server.close()
        );
        await Promise.all([server.connect(st), client.connect(ct)]);
        return client;
    }
    it('keeps different scoped servers isolated while sharing one client', async () => {
        const discoveryService = discovery();
        const api = {
            setSwitchPortName: vi.fn().mockResolvedValue({ written: true }),
            setApRadio: vi.fn().mockResolvedValue({ written: true }),
            genericApiCall: vi.fn().mockResolvedValue({}),
            searchApiOperations: discoveryService.service.searchApiOperations.bind(discoveryService.service),
            describeApiOperation: discoveryService.service.describeApiOperation.bind(discoveryService.service),
            executeApiOperation: discoveryService.service.executeApiOperation.bind(discoveryService.service),
        };
        const wireless = await connect(api, 'all:r,wireless:rw');
        const switching = await connect(api, 'all:r,switching:rw');
        const names = (await wireless.listTools()).tools.map((tool) => tool.name);
        expect(names).toContain('setApRadio');
        expect(names).not.toContain('setSwitchPortName');
        expect((await switching.listTools()).tools.map((tool) => tool.name)).toContain('setSwitchPortName');
        expect(
            (await wireless.callTool({ name: 'setSwitchPortName', arguments: { switchMac: 'AA-BB-CC-DD-EE-FF', port: 1, name: 'test' } })).isError
        ).toBe(true);
        expect(
            (await wireless.callTool({ name: 'genericApiCall', arguments: { method: 'POST', path: '/sites/s/rate-limit-profiles', body: {} } }))
                .isError
        ).toBe(true);
        expect((await wireless.callTool({ name: 'executeApiOperation', arguments: { operationId: 'clientWrite', dryRun: false } })).isError).toBe(
            true
        );
        expect(api.setSwitchPortName).not.toHaveBeenCalled();
        expect(api.genericApiCall).not.toHaveBeenCalled();
        expect(discoveryService.request.request).not.toHaveBeenCalled();
        expect(
            (await switching.callTool({ name: 'setSwitchPortName', arguments: { switchMac: 'AA-BB-CC-DD-EE-FF', port: 1, name: 'test' } })).isError
        ).toBeFalsy();
        expect(api.setSwitchPortName).toHaveBeenCalledTimes(1);
    });

    it('exposes only the diagnostics granted to each scoped MCP server', async () => {
        const api = {
            getTrafficHistory: vi.fn().mockResolvedValue({ sections: { traffic: { status: 'ok' } } }),
            getWifiHistory: vi.fn().mockResolvedValue({ sections: { channels: { status: 'partial' } } }),
            diagnoseWan: vi.fn().mockResolvedValue({ sections: { status: { status: 'ok' } } }),
            updateRateLimitProfile: vi.fn(),
            rollbackNetworkChange: vi.fn(),
        };
        for (const [category, name, arguments_] of [
            ['monitoring', 'getTrafficHistory', { maxSamples: 3 }],
            ['wireless', 'getWifiHistory', { apMac: 'AA-BB-CC-DD-EE-FF' }],
            ['network', 'diagnoseWan', { gatewayMac: 'AA-BB-CC-DD-EE-FF' }],
        ] as const) {
            const client = await connect(api, `${category}:r`);
            const names = (await client.listTools()).tools.map((tool) => tool.name);
            expect(names).toContain(name);
            expect(['getTrafficHistory', 'getWifiHistory', 'diagnoseWan'].filter((tool) => names.includes(tool))).toEqual([name]);
            expect(names).not.toContain('updateRateLimitProfile');
            expect(names).not.toContain('rollbackNetworkChange');
            expect((await client.callTool({ name, arguments: arguments_ })).isError).toBeFalsy();
            expect(api[name]).toHaveBeenCalledExactlyOnceWith(arguments_);
        }
        expect(api.updateRateLimitProfile).not.toHaveBeenCalled();
        expect(api.rollbackNetworkChange).not.toHaveBeenCalled();
    });

    it('blocks rate-profile write and rollback attempts in unrelated or read-only scopes before backend calls', async () => {
        const api = {
            updateRateLimitProfile: vi.fn().mockResolvedValue({ written: true }),
            rollbackNetworkChange: vi.fn().mockResolvedValue({ written: true }),
        };
        const argumentsByName = {
            updateRateLimitProfile: { profileId: 'profile', settings: { name: 'After' }, dryRun: false },
            rollbackNetworkChange: {
                receipt: {
                    version: 1,
                    resource: 'rate-limit-profile',
                    controllerId: 'controller',
                    siteId: 'site',
                    profileId: 'profile',
                    before: { name: 'Before', upLimitEnable: false, downLimitEnable: false },
                    applied: { name: 'After', upLimitEnable: false, downLimitEnable: false },
                },
                dryRun: false,
            },
        };
        for (const scope of ['clients:r', 'network:rw', 'monitoring:rw']) {
            const client = await connect(api, scope);
            for (const name of ['updateRateLimitProfile', 'rollbackNetworkChange'] as const) {
                expect((await client.callTool({ name, arguments: argumentsByName[name] })).isError).toBe(true);
            }
        }
        expect(api.updateRateLimitProfile).not.toHaveBeenCalled();
        expect(api.rollbackNetworkChange).not.toHaveBeenCalled();
        const permitted = await connect(api, 'clients:rw');
        for (const name of ['updateRateLimitProfile', 'rollbackNetworkChange'] as const) {
            expect((await permitted.callTool({ name, arguments: argumentsByName[name] })).isError).toBeFalsy();
            expect(api[name]).toHaveBeenCalledTimes(1);
        }
    });

    it('cannot escalate configured read-only or category scope through full server options', async () => {
        const base = new ToolAccessPolicy('read-only', 'all:rw');
        const api = { getToolAccessPolicy: () => base, setApRadio: vi.fn(), genericApiCall: vi.fn() };
        const client = await connect(api, 'all:rw');
        const tools = (await client.listTools()).tools;
        expect(tools.some((tool) => tool.name === 'setApRadio')).toBe(false);
        expect(tools.some((tool) => tool.name === 'genericApiCall')).toBe(false);
        expect((await client.callTool({ name: 'setApRadio', arguments: { apMac: 'AA-BB-CC-DD-EE-FF', radioId: 1 } })).isError).toBe(true);
        expect(api.setApRadio).not.toHaveBeenCalled();

        const configured = { getToolAccessPolicy: () => new ToolAccessPolicy('full', 'all:r,wireless:rw') };
        const restricted = await connect(configured, 'all:r,switching:rw');
        const names = (await restricted.listTools()).tools.map((tool) => tool.name);
        expect(names).not.toContain('setApRadio');
        expect(names).not.toContain('setSwitchPortName');
        expect(names).toContain('getControllerCapabilities');
    });
});
