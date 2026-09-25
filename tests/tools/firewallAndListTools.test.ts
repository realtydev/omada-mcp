import { describe, expect, it, vi } from 'vitest';

describe('Firewall, IP Group, Route, and Log List Tools', () => {
    describe('registerCreateFirewallAclTool', () => {
        it('should register the tool and pass the rule object through to the client', async () => {
            const { registerCreateFirewallAclTool } = await import('../../src/tools/createFirewallAcl.js');

            const rule = { name: 'Block Guest to LAN', policy: 0 };
            const mockClient = { createFirewallAcl: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', rule }, {})),
            };

            registerCreateFirewallAclTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'createFirewallAcl',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.createFirewallAcl).toHaveBeenCalledWith(rule, 'test-site');
        });
    });

    describe('registerUpdateFirewallAclTool', () => {
        it('should register the tool and pass aclId and the rule object through to the client', async () => {
            const { registerUpdateFirewallAclTool } = await import('../../src/tools/updateFirewallAcl.js');

            const rule = { name: 'Block Guest to LAN', policy: 1 };
            const mockClient = { updateFirewallAcl: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', aclId: 'acl-1', rule }, {})),
            };

            registerUpdateFirewallAclTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'updateFirewallAcl',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.updateFirewallAcl).toHaveBeenCalledWith('acl-1', rule, 'test-site');
        });
    });

    describe('registerDeleteFirewallAclTool', () => {
        it('should register the tool and pass aclId through to the client', async () => {
            const { registerDeleteFirewallAclTool } = await import('../../src/tools/deleteFirewallAcl.js');

            const mockClient = { deleteFirewallAcl: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ aclId: 'acl-1', siteId: 'test-site' }, {})),
            };

            registerDeleteFirewallAclTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'deleteFirewallAcl',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.deleteFirewallAcl).toHaveBeenCalledWith('acl-1', 'test-site');
        });
    });

    describe('registerUpdateFirewallSettingTool', () => {
        it('should register the tool and pass the settings object through to the client', async () => {
            const { registerUpdateFirewallSettingTool } = await import('../../src/tools/updateFirewallSetting.js');

            const settings = { broadcastPing: false, sendRedirects: true };
            const mockClient = { updateFirewallSetting: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', settings }, {})),
            };

            registerUpdateFirewallSettingTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'updateFirewallSetting',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.updateFirewallSetting).toHaveBeenCalledWith(settings, 'test-site');
        });
    });

    describe('registerSetIpsSettingTool', () => {
        it('should register the tool and assemble enable/mode/level/settings into one body', async () => {
            const { registerSetIpsSettingTool } = await import('../../src/tools/setIpsSetting.js');

            const mockClient = { setIpsSetting: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ siteId: 'test-site', enable: true, mode: 'IDS', level: 'low', settings: { allowList: [] } }, {})
                ),
            };

            registerSetIpsSettingTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setIpsSetting',
                expect.objectContaining({ description: expect.any(String), annotations: { destructiveHint: true } }),
                expect.any(Function)
            );
            expect(mockClient.setIpsSetting).toHaveBeenCalledWith({ enable: true, mode: 'IDS', level: 'low', allowList: [] }, 'test-site');
        });

        it('should omit mode/level when not provided', async () => {
            const { registerSetIpsSettingTool } = await import('../../src/tools/setIpsSetting.js');

            const mockClient = { setIpsSetting: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', enable: false }, {})),
            };

            registerSetIpsSettingTool(mockServer as never, mockClient as never);

            expect(mockClient.setIpsSetting).toHaveBeenCalledWith({ enable: false }, 'test-site');
        });
    });

    describe('registerListFirewallAclsTool', () => {
        it('should register the tool and pass siteId through to the client', async () => {
            const { registerListFirewallAclsTool } = await import('../../src/tools/listFirewallAcls.js');

            const mockClient = { listFirewallAcls: vi.fn().mockResolvedValue([]) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site' }, {})),
            };

            registerListFirewallAclsTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'listFirewallAcls',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.listFirewallAcls).toHaveBeenCalledWith('test-site');
        });
    });

    describe('registerListIpGroupsTool', () => {
        it('should register the tool and pass siteId through to the client', async () => {
            const { registerListIpGroupsTool } = await import('../../src/tools/listIpGroups.js');

            const mockClient = { listIpGroups: vi.fn().mockResolvedValue([]) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site' }, {})),
            };

            registerListIpGroupsTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'listIpGroups',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.listIpGroups).toHaveBeenCalledWith('test-site');
        });
    });

    describe('registerListRoutesTool', () => {
        it('should register the tool and pass siteId through to the client', async () => {
            const { registerListRoutesTool } = await import('../../src/tools/listRoutes.js');

            const mockClient = { listRoutes: vi.fn().mockResolvedValue([]) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site' }, {})),
            };

            registerListRoutesTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'listRoutes',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.listRoutes).toHaveBeenCalledWith('test-site');
        });
    });

    describe('registerListEventsTool', () => {
        it('should register the tool and pass pagination args through to the client', async () => {
            const { registerListEventsTool } = await import('../../src/tools/listEvents.js');

            const mockClient = { listEvents: vi.fn().mockResolvedValue([]) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', page: 2, pageSize: 25 }, {})),
            };

            registerListEventsTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'listEvents',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.listEvents).toHaveBeenCalledWith('test-site', 2, 25, undefined, undefined, undefined, undefined, undefined);
        });

        it('should pass the module filter through to the client', async () => {
            const { registerListEventsTool } = await import('../../src/tools/listEvents.js');

            const mockClient = { listEvents: vi.fn().mockResolvedValue([]) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', page: 1, pageSize: 10, module: 'Client' }, {})),
            };

            registerListEventsTool(mockServer as never, mockClient as never);

            expect(mockClient.listEvents).toHaveBeenCalledWith('test-site', 1, 10, undefined, undefined, 'Client', undefined, undefined);
        });
    });

    describe('registerListEventsTool key filters', () => {
        it('should pass the key prefix filters through to the client', async () => {
            const { registerListEventsTool } = await import('../../src/tools/listEvents.js');

            const mockClient = { listEvents: vi.fn().mockResolvedValue([]) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ siteId: 'test-site', page: 1, pageSize: 10, keyPrefix: 'DEV_', excludeKeyPrefix: 'OSG_' }, {})
                ),
            };

            registerListEventsTool(mockServer as never, mockClient as never);

            expect(mockClient.listEvents).toHaveBeenCalledWith('test-site', 1, 10, undefined, undefined, undefined, 'DEV_', 'OSG_');
        });
    });

    describe('registerListAlertsTool', () => {
        it('should register the tool and pass filters through to the client', async () => {
            const { registerListAlertsTool } = await import('../../src/tools/listAlerts.js');

            const mockClient = { listAlerts: vi.fn().mockResolvedValue([]) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) =>
                    handler({ siteId: 'test-site', page: 2, pageSize: 25, module: 'Device', resolved: false }, {})
                ),
            };

            registerListAlertsTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'listAlerts',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.listAlerts).toHaveBeenCalledWith('test-site', 2, 25, undefined, undefined, 'Device', false);
        });
    });

    describe('registerListLogsTool', () => {
        it('should register the tool and pass pagination args through to the client', async () => {
            const { registerListLogsTool } = await import('../../src/tools/listLogs.js');

            const mockClient = { listLogs: vi.fn().mockResolvedValue([]) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', page: 1, pageSize: 10 }, {})),
            };

            registerListLogsTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'listLogs',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.listLogs).toHaveBeenCalledWith('test-site', 1, 10);
        });
    });
});
