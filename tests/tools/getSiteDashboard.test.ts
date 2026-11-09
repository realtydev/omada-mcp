import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerGetSiteDashboardTool } from '../../src/tools/getSiteDashboard.js';

function setup() {
    const server = { registerTool: vi.fn() };
    const client = { getSiteDashboard: vi.fn() };
    registerGetSiteDashboardTool(server as unknown as McpServer, client as unknown as OmadaClient);
    const [name, config, handler] = server.registerTool.mock.calls[0];
    return { name, config, handler, client };
}

describe('getSiteDashboard tool', () => {
    it('registers a strict read-only schema with explicit second-based windows', () => {
        const { name, config } = setup();
        expect(name).toBe('getSiteDashboard');
        expect(config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
        expect(config.inputSchema.safeParse({}).success).toBe(true);
        expect(config.inputSchema.safeParse({ start: -1 }).success).toBe(false);
        expect(config.inputSchema.safeParse({ end: 1.2 }).success).toBe(false);
        expect(config.inputSchema.safeParse({ unknown: true }).success).toBe(false);
    });

    it('preserves partial results and forwards the requested site and window', async () => {
        const { client, handler } = setup();
        const partial = { collectionComplete: false, sections: { wifi: { status: 'error', message: 'unsupported' } } };
        client.getSiteDashboard.mockResolvedValue(partial);
        const result = await handler({ siteId: 'site', start: 1000, end: 2000 }, {});
        expect(client.getSiteDashboard).toHaveBeenCalledExactlyOnceWith({ siteId: 'site', start: 1000, end: 2000 });
        expect(JSON.parse(result.content[0].text)).toEqual(partial);
    });

    it('propagates invalid operation windows through the shared tool handler', async () => {
        const { client, handler } = setup();
        client.getSiteDashboard.mockRejectedValue(new Error('Window is invalid'));
        await expect(handler({ start: 2000, end: 1000 }, {})).rejects.toThrow('Window is invalid');
    });
});
