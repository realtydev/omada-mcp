import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerGetSiteTopologyTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getSiteTopology',
        {
            description:
                'Read the controller topology tree, uplinks, port speeds, and last update time. Requires web UI credentials. Discovery can omit unmanaged links; this is the controller view, not a physical cable audit.',
            inputSchema: z.object({ siteId: z.string().min(1).optional() }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getSiteTopology', async ({ siteId }) => toToolResult(await client.getSiteTopology(siteId)))
    );
}
