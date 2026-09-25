import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerGetClientTool } from '../../src/tools/getClient.js';
import { registerGetFirewallSettingTool } from '../../src/tools/getFirewallSetting.js';
import { registerGetInternetInfoTool } from '../../src/tools/getInternetInfo.js';
import * as loggerModule from '../../src/utils/logger.js';

describe('tools - simple get operations', () => {
    let mockServer: McpServer;
    let mockClient: OmadaClient;
    let toolHandler: (args: unknown, extra: { sessionId?: string }) => Promise<unknown>;

    beforeEach(() => {
        mockServer = {
            registerTool: vi.fn((name, schema, handler) => {
                toolHandler = handler;
            }),
        } as unknown as McpServer;

        mockClient = {
            getClient: vi.fn(),
            getFirewallSetting: vi.fn(),
            getInternetInfo: vi.fn(),
        } as unknown as OmadaClient;

        vi.spyOn(loggerModule.logger, 'info').mockImplementation(() => {
            // Mock implementation
        });
        vi.spyOn(loggerModule.logger, 'error').mockImplementation(() => {
            // Mock implementation
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('getClient', () => {
        it('should execute successfully', async () => {
            const mockClientData = { mac: '00:11:22:33:44:55', name: 'Client 1' };
            (mockClient.getClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClientData);

            registerGetClientTool(mockServer, mockClient as never);
            const result = await toolHandler({ clientId: '00:11:22:33:44:55' }, {});

            expect(result).toBeDefined();
        });
    });

    describe('getFirewallSetting', () => {
        it('should execute successfully', async () => {
            const mockFirewall = { enabled: true };
            (mockClient.getFirewallSetting as ReturnType<typeof vi.fn>).mockResolvedValue(mockFirewall);

            registerGetFirewallSettingTool(mockServer, mockClient);
            const result = await toolHandler({}, {});

            expect(result).toBeDefined();
        });
    });

    describe('getInternetInfo', () => {
        it('should execute successfully', async () => {
            const mockInfo = { status: 'connected' };
            (mockClient.getInternetInfo as ReturnType<typeof vi.fn>).mockResolvedValue(mockInfo);

            registerGetInternetInfoTool(mockServer, mockClient);
            const result = await toolHandler({}, {});

            expect(result).toBeDefined();
        });
    });

    describe('registerGetApRadiosTool', () => {
        it('should register the tool and pass apMac and siteId through to the client', async () => {
            const { registerGetApRadiosTool } = await import('../../src/tools/getApRadios.js');

            const mockClient = { getApRadios: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ apMac: 'AA-BB-CC-DD-EE-FF', siteId: 'test-site' }, {})),
            };

            registerGetApRadiosTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'getApRadios',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.getApRadios).toHaveBeenCalledWith('AA-BB-CC-DD-EE-FF', 'test-site');
        });
    });

    describe('registerGetClientHistoryTool', () => {
        it('should register the tool and pass its options through to the client', async () => {
            const { registerGetClientHistoryTool } = await import('../../src/tools/getClientHistory.js');

            const mockClient = { getClientHistory: vi.fn().mockResolvedValue({ sessions: [] }) };
            const args = { siteId: 'test-site', clientMac: 'AA-BB-CC-DD-EE-FF', timeStart: 1, timeEnd: 2, roamTimeline: true, maxGapSeconds: 30 };
            const mockServer = { registerTool: vi.fn((_, _schema, handler) => handler(args, {})) };

            registerGetClientHistoryTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'getClientHistory',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.getClientHistory).toHaveBeenCalledWith(args);
        });
    });
});
