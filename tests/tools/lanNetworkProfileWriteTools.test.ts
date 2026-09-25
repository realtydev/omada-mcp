import { describe, expect, it, vi } from 'vitest';

describe('LAN Network and Profile Write Tools', () => {
    describe('registerCreateLanNetworkTool', () => {
        it('should register the tool and pass the network data through to the client', async () => {
            const { registerCreateLanNetworkTool } = await import('../../src/tools/createLanNetwork.js');

            const data = {
                name: 'Guest Network',
                vlan: 20,
                gatewaySubnet: '192.168.20.1/24',
                purpose: 1,
                igmpSnoopEnable: false,
                interfaceIds: ['2_e144ec2260ca4f3da50e7912b0b9947e'],
                dhcpSettingsVO: { enable: true, ipRangePool: [{ ipaddrStart: '192.168.20.100', ipaddrEnd: '192.168.20.200' }], leasetime: 1440 },
            };
            const mockClient = { createLanNetwork: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', ...data }, {})),
            };

            registerCreateLanNetworkTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'createLanNetwork',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.createLanNetwork).toHaveBeenCalledWith(data, 'test-site');
        });
    });

    describe('registerUpdateLanNetworkTool', () => {
        it('should register the tool and pass networkId and update data through to the client', async () => {
            const { registerUpdateLanNetworkTool } = await import('../../src/tools/updateLanNetwork.js');

            const data = {
                name: 'Guest Network',
                vlan: 20,
                gatewaySubnet: '192.168.20.1/24',
                purpose: 1,
                igmpSnoopEnable: false,
                interfaceIds: ['2_e144ec2260ca4f3da50e7912b0b9947e'],
                dhcpSettingsVO: { enable: true, ipRangePool: [{ ipaddrStart: '192.168.20.100', ipaddrEnd: '192.168.20.200' }], leasetime: 1440 },
            };
            const mockClient = { updateLanNetwork: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', networkId: 'net-1', ...data }, {})),
            };

            registerUpdateLanNetworkTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'updateLanNetwork',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.updateLanNetwork).toHaveBeenCalledWith('net-1', data, 'test-site');
        });
    });

    describe('registerDeleteLanNetworkTool', () => {
        it('should register the tool and pass networkId through to the client', async () => {
            const { registerDeleteLanNetworkTool } = await import('../../src/tools/deleteLanNetwork.js');

            const mockClient = { deleteLanNetwork: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', networkId: 'net-1' }, {})),
            };

            registerDeleteLanNetworkTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'deleteLanNetwork',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.deleteLanNetwork).toHaveBeenCalledWith('net-1', 'test-site');
        });
    });

    describe('registerCreateLanProfileTool', () => {
        it('should register the tool and pass the profile data through to the client', async () => {
            const { registerCreateLanProfileTool } = await import('../../src/tools/createLanProfile.js');

            const data = {
                name: 'Corporate',
                nativeNetworkId: 'net-1',
                tagNetworkIds: ['net-2'],
                poe: true,
                spanningTreeEnable: true,
                loopbackDetectEnable: true,
                portIsolationEnable: false,
                lldpMedEnable: true,
            };
            const mockClient = { createLanProfile: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', ...data }, {})),
            };

            registerCreateLanProfileTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'createLanProfile',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.createLanProfile).toHaveBeenCalledWith(data, 'test-site');
        });
    });

    describe('registerUpdateLanProfileTool', () => {
        it('should register the tool and pass profileId and update data through to the client', async () => {
            const { registerUpdateLanProfileTool } = await import('../../src/tools/updateLanProfile.js');

            const data = {
                name: 'Corporate',
                nativeNetworkId: 'net-1',
                tagNetworkIds: ['net-2'],
                poe: true,
                spanningTreeEnable: true,
                loopbackDetectEnable: true,
                portIsolationEnable: false,
                lldpMedEnable: true,
            };
            const mockClient = { updateLanProfile: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', profileId: 'profile-1', ...data }, {})),
            };

            registerUpdateLanProfileTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'updateLanProfile',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.updateLanProfile).toHaveBeenCalledWith('profile-1', data, 'test-site');
        });
    });
});
