import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerGetSwitchPortOverviewTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getSwitchPortOverview',
        {
            description:
                'Read managed-switch port inventories and live telemetry, including non-PoE switches through the configured web API. Reports per-switch coverage, source failures and missing telemetry explicitly. Administrative settings stay separate from live link/speed evidence. Bounded read only; gateway-integrated ports are outside this scope.',
            inputSchema: z.object({ switchMac: z.string().min(1).optional(), siteId: z.string().min(1).optional() }).strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getSwitchPortOverview', async ({ switchMac, siteId }) => toToolResult(await client.getSwitchPortOverview(switchMac, siteId)))
    );
}
