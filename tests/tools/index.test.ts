import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerAllTools } from '../../src/tools/index.js';

describe('tools/index', () => {
    let mockServer: McpServer;
    let mockClient: OmadaClient;

    beforeEach(() => {
        mockServer = {
            registerTool: vi.fn(),
        } as unknown as McpServer;

        mockClient = {} as OmadaClient;
    });

    describe('registerAllTools', () => {
        it('should register all tools with the server', () => {
            registerAllTools(mockServer, mockClient);

            // Verify registerTool was called for each tool
            const expectedTools = [
                // Read tools
                'listSites',
                'listDevices',
                'listClients',
                'getDevice',
                'getApRadios',
                'getClientHistory',
                'getSwitchStackDetail',
                'getClient',
                'searchDevices',
                'listDevicesStats',
                'listMostActiveClients',
                'listClientsActivity',
                'listClientsPastConnections',
                'getThreatList',
                'getInternetInfo',
                'getPortForwardingStatus',
                'getLanNetworkList',
                'getLanProfileList',
                'getWlanGroupList',
                'getSsidList',
                'getSsidDetail',
                'getFirewallSetting',
                'getIpsSetting',
                'getFirmwareDetails',
                'listAlerts',
                'listEvents',
                'listLogs',
                'listFirewallAcls',
                'listIpGroups',
                'listRoutes',
                'getSwitch',
                'getCableTestResults',
                'getSwitchNetworks',
                // Write tools
                'createLanNetwork',
                'updateLanNetwork',
                'deleteLanNetwork',
                'createLanProfile',
                'updateLanProfile',
                'updateFirewallSetting',
                'setIpsSetting',
                'createFirewallAcl',
                'updateFirewallAcl',
                'deleteFirewallAcl',
                'updateSsid',
                'setSsidEnable',
                'updateSwitchPort',
                'updateClient',
                'setSwitchNetworks',
                'createRoute',
                'updateRoute',
                'deleteRoute',
                'createPortForward',
                'updatePortForward',
                'deletePortForward',
                'updateWanPortSetting',
                // Switch port tools
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
                // Action tools
                'rebootDevice',
                'adoptDevice',
                'blockClient',
                'unblockClient',
                'reconnectClient',
                'setDeviceLed',
                'setApRadio',
                'setLogNotifications',
                'startFirmwareUpgrade',
                'setGatewayWanConnect',
                // Generic
                'genericApiCall',
                // Meta
                'getServerInfo',
            ];

            for (const tool of expectedTools) {
                expect(mockServer.registerTool).toHaveBeenCalledWith(tool, expect.any(Object), expect.any(Function));
            }

            // Verify total number of tools registered
            expect(mockServer.registerTool).toHaveBeenCalledTimes(expectedTools.length);
        });
    });
});
