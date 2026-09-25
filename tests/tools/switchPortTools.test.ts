import { describe, expect, it, vi } from 'vitest';

describe('Switch Port Tools', () => {
    describe('registerSetSwitchPortNameTool', () => {
        it('should register the tool and pass port args through to the client', async () => {
            const { registerSetSwitchPortNameTool } = await import('../../src/tools/setSwitchPortName.js');

            const mockClient = { setSwitchPortName: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ switchMac: '00:11:22:33:44:55', port: 1, name: 'Uplink', siteId: 'test-site' }, {})
                ),
            };

            registerSetSwitchPortNameTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setSwitchPortName',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.setSwitchPortName).toHaveBeenCalledWith('00:11:22:33:44:55', 1, 'Uplink', 'test-site');
        });
    });

    describe('registerSetSwitchPortPoeTool', () => {
        it('should register the tool and pass port args through to the client', async () => {
            const { registerSetSwitchPortPoeTool } = await import('../../src/tools/setSwitchPortPoe.js');

            const mockClient = { setSwitchPortPoe: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ switchMac: '00:11:22:33:44:55', port: 2, poeMode: 1, siteId: 'test-site' }, {})
                ),
            };

            registerSetSwitchPortPoeTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setSwitchPortPoe',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.setSwitchPortPoe).toHaveBeenCalledWith('00:11:22:33:44:55', 2, 1, 'test-site');
        });
    });

    describe('registerSetSwitchPortProfileTool', () => {
        it('should register the tool and pass port args through to the client', async () => {
            const { registerSetSwitchPortProfileTool } = await import('../../src/tools/setSwitchPortProfile.js');

            const mockClient = { setSwitchPortProfile: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ switchMac: '00:11:22:33:44:55', port: 3, profileId: 'profile-1', siteId: 'test-site' }, {})
                ),
            };

            registerSetSwitchPortProfileTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setSwitchPortProfile',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.setSwitchPortProfile).toHaveBeenCalledWith('00:11:22:33:44:55', 3, 'profile-1', 'test-site');
        });
    });

    describe('registerSetSwitchPortProfileOverrideTool', () => {
        it('should register the tool and pass port args through to the client', async () => {
            const { registerSetSwitchPortProfileOverrideTool } = await import('../../src/tools/setSwitchPortProfileOverride.js');

            const mockClient = { setSwitchPortProfileOverride: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ switchMac: '00:11:22:33:44:55', port: 4, profileOverrideEnable: true, siteId: 'test-site' }, {})
                ),
            };

            registerSetSwitchPortProfileOverrideTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setSwitchPortProfileOverride',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.setSwitchPortProfileOverride).toHaveBeenCalledWith('00:11:22:33:44:55', 4, true, 'test-site');
        });
    });

    describe('registerSetSwitchPortStatusTool', () => {
        it('should register the tool and pass port args through to the client', async () => {
            const { registerSetSwitchPortStatusTool } = await import('../../src/tools/setSwitchPortStatus.js');

            const mockClient = { setSwitchPortStatus: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ switchMac: '00:11:22:33:44:55', port: 5, status: 0, siteId: 'test-site' }, {})
                ),
            };

            registerSetSwitchPortStatusTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setSwitchPortStatus',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.setSwitchPortStatus).toHaveBeenCalledWith('00:11:22:33:44:55', 5, 0, 'test-site');
        });
    });

    describe('registerBatchSetSwitchPortNameTool', () => {
        it('should register the tool and pass portNameList through to the client', async () => {
            const { registerBatchSetSwitchPortNameTool } = await import('../../src/tools/batchSetSwitchPortName.js');

            const portNameList = [{ port: 1, name: 'Uplink' }];
            const mockClient = { batchSetSwitchPortName: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ switchMac: '00:11:22:33:44:55', portNameList, siteId: 'test-site' }, {})),
            };

            registerBatchSetSwitchPortNameTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'batchSetSwitchPortName',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.batchSetSwitchPortName).toHaveBeenCalledWith('00:11:22:33:44:55', portNameList, 'test-site');
        });
    });

    describe('registerBatchSetSwitchPortPoeTool', () => {
        it('should register the tool and pass portList through to the client', async () => {
            const { registerBatchSetSwitchPortPoeTool } = await import('../../src/tools/batchSetSwitchPortPoe.js');

            const portList = [1, 2, 3];
            const mockClient = { batchSetSwitchPortPoe: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ switchMac: '00:11:22:33:44:55', portList, poeMode: 1, siteId: 'test-site' }, {})
                ),
            };

            registerBatchSetSwitchPortPoeTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'batchSetSwitchPortPoe',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.batchSetSwitchPortPoe).toHaveBeenCalledWith('00:11:22:33:44:55', portList, 1, 'test-site');
        });
    });

    describe('registerBatchSetSwitchPortProfileTool', () => {
        it('should register the tool and pass portList through to the client', async () => {
            const { registerBatchSetSwitchPortProfileTool } = await import('../../src/tools/batchSetSwitchPortProfile.js');

            const portList = [1, 2, 3];
            const mockClient = { batchSetSwitchPortProfile: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ switchMac: '00:11:22:33:44:55', portList, profileOverrideEnable: false, siteId: 'test-site' }, {})
                ),
            };

            registerBatchSetSwitchPortProfileTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'batchSetSwitchPortProfile',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.batchSetSwitchPortProfile).toHaveBeenCalledWith('00:11:22:33:44:55', portList, false, 'test-site');
        });
    });

    describe('registerBatchSetSwitchPortStatusTool', () => {
        it('should register the tool and pass portList through to the client', async () => {
            const { registerBatchSetSwitchPortStatusTool } = await import('../../src/tools/batchSetSwitchPortStatus.js');

            const portList = [1, 2, 3];
            const mockClient = { batchSetSwitchPortStatus: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ switchMac: '00:11:22:33:44:55', portList, status: 1, siteId: 'test-site' }, {})
                ),
            };

            registerBatchSetSwitchPortStatusTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'batchSetSwitchPortStatus',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.batchSetSwitchPortStatus).toHaveBeenCalledWith('00:11:22:33:44:55', portList, 1, 'test-site');
        });
    });

    describe('registerStartCableTestTool', () => {
        it('should register the tool and pass switchMac through to the client', async () => {
            const { registerStartCableTestTool } = await import('../../src/tools/startCableTest.js');

            const mockClient = { startCableTest: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ switchMac: '00:11:22:33:44:55', siteId: 'test-site' }, {})),
            };

            registerStartCableTestTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'startCableTest',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.startCableTest).toHaveBeenCalledWith('00:11:22:33:44:55', 'test-site');
        });
    });

    describe('registerGetCableTestResultsTool', () => {
        it('should register the tool and pass switchMac through to the client', async () => {
            const { registerGetCableTestResultsTool } = await import('../../src/tools/getCableTestResults.js');

            const mockClient = { getCableTestResults: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ switchMac: '00:11:22:33:44:55', siteId: 'test-site' }, {})),
            };

            registerGetCableTestResultsTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'getCableTestResults',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.getCableTestResults).toHaveBeenCalledWith('00:11:22:33:44:55', 'test-site');
        });
    });

    describe('registerGetSwitchTool', () => {
        it('should register the tool and pass switchMac through to the client', async () => {
            const { registerGetSwitchTool } = await import('../../src/tools/getSwitch.js');

            const mockClient = { getSwitch: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ switchMac: '00:11:22:33:44:55', siteId: 'test-site' }, {})),
            };

            registerGetSwitchTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'getSwitch',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.getSwitch).toHaveBeenCalledWith('00:11:22:33:44:55', 'test-site');
        });
    });

    describe('registerGetSwitchNetworksTool', () => {
        it('should register the tool and pass switchMac through to the client', async () => {
            const { registerGetSwitchNetworksTool } = await import('../../src/tools/getSwitchNetworks.js');

            const mockClient = { getSwitchNetworks: vi.fn().mockResolvedValue([]) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ switchMac: '00:11:22:33:44:55', siteId: 'test-site' }, {})),
            };

            registerGetSwitchNetworksTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'getSwitchNetworks',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.getSwitchNetworks).toHaveBeenCalledWith('00:11:22:33:44:55', 'test-site');
        });
    });

    describe('registerSetSwitchNetworksTool', () => {
        it('should register the tool and pass switchMac and data through to the client', async () => {
            const { registerSetSwitchNetworksTool } = await import('../../src/tools/setSwitchNetworks.js');

            const data = { vlanTrunk: true };
            const mockClient = { setSwitchNetworks: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ switchMac: '00:11:22:33:44:55', data, siteId: 'test-site' }, {})),
            };

            registerSetSwitchNetworksTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setSwitchNetworks',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.setSwitchNetworks).toHaveBeenCalledWith('00:11:22:33:44:55', data, 'test-site');
        });
    });

    describe('registerUpdateSwitchPortTool', () => {
        it('should register the tool and pass switchMac, portId, and update data through to the client', async () => {
            const { registerUpdateSwitchPortTool } = await import('../../src/tools/updateSwitchPort.js');

            const mockClient = { updateSwitchPort: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ siteId: 'test-site', switchMac: '00:11:22:33:44:55', portId: 'port-1', poe: true, linkSpeed: 1000 }, {})
                ),
            };

            registerUpdateSwitchPortTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'updateSwitchPort',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.updateSwitchPort).toHaveBeenCalledWith('00:11:22:33:44:55', 'port-1', { poe: true, linkSpeed: 1000 }, 'test-site');
        });
    });
});
