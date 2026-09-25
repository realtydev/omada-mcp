import { describe, expect, it, vi } from 'vitest';

describe('Static Route and Port Forwarding Write Tools', () => {
    describe('registerCreateRouteTool', () => {
        it('should register the tool and pass the route object through to the client', async () => {
            const { registerCreateRouteTool } = await import('../../src/tools/createRoute.js');

            const route = {
                name: 'claude-mcp-test',
                status: true,
                destinations: ['203.0.113.0/24'],
                routeType: 0,
                nextHopIp: '192.168.0.1',
                metric: '15',
            };
            const mockClient = { createRoute: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', route }, {})),
            };

            registerCreateRouteTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'createRoute',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.createRoute).toHaveBeenCalledWith(route, 'test-site');
        });
    });

    describe('registerUpdateRouteTool', () => {
        it('should register the tool and pass routeId and the route object through to the client', async () => {
            const { registerUpdateRouteTool } = await import('../../src/tools/updateRoute.js');

            const route = {
                name: 'claude-mcp-test',
                status: true,
                destinations: ['203.0.113.0/24'],
                routeType: 0,
                nextHopIp: '192.168.0.1',
                metric: '5',
            };
            const mockClient = { updateRoute: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', routeId: 'route-1', route }, {})),
            };

            registerUpdateRouteTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'updateRoute',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.updateRoute).toHaveBeenCalledWith('route-1', route, 'test-site');
        });
    });

    describe('registerDeleteRouteTool', () => {
        it('should register the tool and pass routeId through to the client', async () => {
            const { registerDeleteRouteTool } = await import('../../src/tools/deleteRoute.js');

            const mockClient = { deleteRoute: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', routeId: 'route-1' }, {})),
            };

            registerDeleteRouteTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'deleteRoute',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.deleteRoute).toHaveBeenCalledWith('route-1', 'test-site');
        });
    });

    describe('registerCreatePortForwardTool', () => {
        it('should register the tool and pass the rule object through to the client', async () => {
            const { registerCreatePortForwardTool } = await import('../../src/tools/createPortForward.js');

            const rule = {
                name: 'claude-mcp-test',
                status: true,
                dMZ: false,
                externalPort: '59999',
                forwardIp: '192.168.0.253',
                forwardPort: '59999',
                protocol: 1,
                from: 0,
                interfaceWanPortId: ['wan-1'],
                virtualWanId: [],
                featureDescription: [],
            };
            const mockClient = { createPortForward: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', rule }, {})),
            };

            registerCreatePortForwardTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'createPortForward',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.createPortForward).toHaveBeenCalledWith(rule, 'test-site');
        });
    });

    describe('registerUpdatePortForwardTool', () => {
        it('should register the tool and pass ruleId and the rule object through to the client', async () => {
            const { registerUpdatePortForwardTool } = await import('../../src/tools/updatePortForward.js');

            const rule = { name: 'claude-mcp-test', externalPort: '60000', forwardPort: '60000' };
            const mockClient = { updatePortForward: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', ruleId: 'rule-1', rule }, {})),
            };

            registerUpdatePortForwardTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'updatePortForward',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.updatePortForward).toHaveBeenCalledWith('rule-1', rule, 'test-site');
        });
    });

    describe('registerDeletePortForwardTool', () => {
        it('should register the tool and pass ruleId through to the client', async () => {
            const { registerDeletePortForwardTool } = await import('../../src/tools/deletePortForward.js');

            const mockClient = { deletePortForward: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', ruleId: 'rule-1' }, {})),
            };

            registerDeletePortForwardTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'deletePortForward',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.deletePortForward).toHaveBeenCalledWith('rule-1', 'test-site');
        });
    });
});
