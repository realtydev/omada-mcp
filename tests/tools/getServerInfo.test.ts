import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { registerGetServerInfoTool } from '../../src/tools/getServerInfo.js';

describe('registerGetServerInfoTool', () => {
    it('should register a strict, argument-less schema and never touch the Omada client', () => {
        const mockClient = {} as never;
        const mockServer = {
            registerTool: vi.fn(),
        } as unknown as McpServer;

        registerGetServerInfoTool(mockServer, mockClient);

        expect(mockServer.registerTool).toHaveBeenCalledWith(
            'getServerInfo',
            expect.objectContaining({ description: expect.any(String) }),
            expect.any(Function)
        );

        const [, config] = vi.mocked(mockServer.registerTool).mock.calls[0];
        // A plain zod object here (not `.shape`) is what keeps registerTool's own validation strict — see strictWriteSchemas.test.ts.
        expect(typeof (config as { inputSchema: { strict?: unknown } }).inputSchema.strict).toBe('function');
    });

    it('should report the package version, git commit, and build time it was built with', async () => {
        const mockServer = { registerTool: vi.fn() } as unknown as McpServer;
        registerGetServerInfoTool(mockServer, {} as never);

        const handler = vi.mocked(mockServer.registerTool).mock.calls[0][2] as (
            args: unknown,
            extra: unknown
        ) => Promise<{ content: { type: string; text: string }[] }>;
        const result = await handler({}, {});

        const reported = JSON.parse(result.content[0].text);
        expect(reported).toEqual({
            packageVersion: expect.any(String),
            gitCommit: expect.any(String),
            buildTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        });
    });
});
