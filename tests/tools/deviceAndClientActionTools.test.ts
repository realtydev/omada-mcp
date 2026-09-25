import { describe, expect, it, vi } from 'vitest';

describe('Device and Client Action Tools', () => {
    describe('registerAdoptDeviceTool', () => {
        it('should register the tool and pass deviceMac through to the client', async () => {
            const { registerAdoptDeviceTool } = await import('../../src/tools/adoptDevice.js');

            const mockClient = { adoptDevice: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', deviceMac: '00:11:22:33:44:55' }, {})),
            };

            registerAdoptDeviceTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'adoptDevice',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.adoptDevice).toHaveBeenCalledWith('00:11:22:33:44:55', 'test-site');
        });
    });

    describe('registerBlockClientTool', () => {
        it('should register the tool and pass clientMac through to the client', async () => {
            const { registerBlockClientTool } = await import('../../src/tools/blockClient.js');

            const mockClient = { blockClient: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ clientMac: 'aa:bb:cc:dd:ee:ff', siteId: 'test-site' }, {})),
            };

            registerBlockClientTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'blockClient',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.blockClient).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 'test-site');
        });
    });

    describe('registerUnblockClientTool', () => {
        it('should register the tool and pass clientMac through to the client', async () => {
            const { registerUnblockClientTool } = await import('../../src/tools/unblockClient.js');

            const mockClient = { unblockClient: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ clientMac: 'aa:bb:cc:dd:ee:ff', siteId: 'test-site' }, {})),
            };

            registerUnblockClientTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'unblockClient',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.unblockClient).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 'test-site');
        });
    });

    describe('registerReconnectClientTool', () => {
        it('should register the tool and pass clientMac through to the client', async () => {
            const { registerReconnectClientTool } = await import('../../src/tools/reconnectClient.js');

            const mockClient = { reconnectClient: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ clientMac: 'aa:bb:cc:dd:ee:ff', siteId: 'test-site' }, {})),
            };

            registerReconnectClientTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'reconnectClient',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.reconnectClient).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 'test-site');
        });
    });

    describe('registerRebootDeviceTool', () => {
        it('should register the tool and pass deviceMac through to the client', async () => {
            const { registerRebootDeviceTool } = await import('../../src/tools/rebootDevice.js');

            const mockClient = { rebootDevice: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ deviceMac: '00:11:22:33:44:55', siteId: 'test-site' }, {})),
            };

            registerRebootDeviceTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'rebootDevice',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.rebootDevice).toHaveBeenCalledWith('00:11:22:33:44:55', 'test-site');
        });
    });

    describe('registerSetDeviceLedTool', () => {
        it('should register the tool and pass deviceMac and ledSetting through to the client', async () => {
            const { registerSetDeviceLedTool } = await import('../../src/tools/setDeviceLed.js');

            const mockClient = { setDeviceLed: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ deviceMac: '00:11:22:33:44:55', ledSetting: 1, siteId: 'test-site' }, {})),
            };

            registerSetDeviceLedTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setDeviceLed',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.setDeviceLed).toHaveBeenCalledWith('00:11:22:33:44:55', 1, 'test-site');
        });
    });

    describe('registerStartFirmwareUpgradeTool', () => {
        it('should register the tool and pass deviceMac through to the client', async () => {
            const { registerStartFirmwareUpgradeTool } = await import('../../src/tools/startFirmwareUpgrade.js');

            const mockClient = { startFirmwareUpgrade: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ deviceMac: '00:11:22:33:44:55', siteId: 'test-site' }, {})),
            };

            registerStartFirmwareUpgradeTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'startFirmwareUpgrade',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.startFirmwareUpgrade).toHaveBeenCalledWith('00:11:22:33:44:55', 'test-site');
        });
    });

    describe('registerGetFirmwareDetailsTool', () => {
        it('should register the tool and pass deviceMac through to the client', async () => {
            const { registerGetFirmwareDetailsTool } = await import('../../src/tools/getFirmwareDetails.js');

            const mockClient = { getFirmwareDetails: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ deviceMac: '00:11:22:33:44:55', siteId: 'test-site' }, {})),
            };

            registerGetFirmwareDetailsTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'getFirmwareDetails',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.getFirmwareDetails).toHaveBeenCalledWith('00:11:22:33:44:55', 'test-site');
        });
    });

    describe('registerSetGatewayWanConnectTool', () => {
        it('should register the tool and pass gateway args through to the client', async () => {
            const { registerSetGatewayWanConnectTool } = await import('../../src/tools/setGatewayWanConnect.js');

            const mockClient = { setGatewayWanConnect: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ gatewayMac: '00:11:22:33:44:55', portId: 'wan-1', action: 'connect', siteId: 'test-site' }, {})
                ),
            };

            registerSetGatewayWanConnectTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setGatewayWanConnect',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.setGatewayWanConnect).toHaveBeenCalledWith('00:11:22:33:44:55', 'wan-1', 'connect', 'test-site');
        });
    });

    describe('registerUpdateWanPortSettingTool', () => {
        it('should register the tool and pass the port setting object through to the client', async () => {
            const { registerUpdateWanPortSettingTool } = await import('../../src/tools/updateWanPortSetting.js');

            const portSetting = {
                portId: 'wan-1',
                wanPortIpv4Setting: { protoType: 1, vlanId: 0, ipv4Dhcp: { unicastDhcp: true, mtu: 1500 } },
                wanPortIpv6Setting: {},
                wanPortMacSetting: {},
            };
            const mockClient = { updateWanPortSetting: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', portSetting }, {})),
            };

            registerUpdateWanPortSettingTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'updateWanPortSetting',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.updateWanPortSetting).toHaveBeenCalledWith(portSetting, 'test-site');
        });
    });

    describe('registerUpdateClientTool', () => {
        it('should register the tool and pass clientMac and update data through to the client', async () => {
            const { registerUpdateClientTool } = await import('../../src/tools/updateClient.js');

            const mockClient = { updateClient: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ siteId: 'test-site', clientMac: 'aa:bb:cc:dd:ee:ff', name: 'Laptop', fixedIp: '192.168.1.50' }, {})
                ),
            };

            registerUpdateClientTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'updateClient',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.updateClient).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', { name: 'Laptop', fixedIp: '192.168.1.50' }, 'test-site');
        });
    });

    describe('registerSetApRadioTool', () => {
        it('should register the tool and split band and site from the radio settings', async () => {
            const { registerSetApRadioTool } = await import('../../src/tools/setApRadio.js');

            const mockClient = { setApRadio: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ apMac: 'AA-BB-CC-DD-EE-FF', band: '5g', siteId: 'test-site', channel: 1, channelWidth: 5, dryRun: true }, {})
                ),
            };

            registerSetApRadioTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setApRadio',
                expect.objectContaining({ description: expect.any(String), annotations: { destructiveHint: true } }),
                expect.any(Function)
            );
            expect(mockClient.setApRadio).toHaveBeenCalledWith('AA-BB-CC-DD-EE-FF', '5g', { channel: 1, channelWidth: 5 }, 'test-site', true);
        });
    });

    describe('registerSetLogNotificationsTool', () => {
        it('should register the tool and pass its options through to the client', async () => {
            const { registerSetLogNotificationsTool } = await import('../../src/tools/setLogNotifications.js');

            const mockClient = { setLogNotifications: vi.fn().mockResolvedValue({}) };
            const args = { siteId: 'test-site', events: [{ key: 'W_C_ROAM', enable: true }], alerts: undefined, dryRun: true };
            const mockServer = { registerTool: vi.fn((_, _schema, handler) => handler(args, {})) };

            registerSetLogNotificationsTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setLogNotifications',
                expect.objectContaining({ description: expect.any(String), annotations: { destructiveHint: true } }),
                expect.any(Function)
            );
            expect(mockClient.setLogNotifications).toHaveBeenCalledWith(args);
        });
    });
});
