import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const dashboardSchema = z
    .object({
        siteId: z.string().min(1).optional(),
        start: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Window start, epoch seconds; defaults to one hour before end. Maximum window: 24 hours.'),
        end: z.number().int().nonnegative().optional().describe('Window end, epoch seconds; defaults to now. Future windows are rejected.'),
    })
    .strict();

export function registerGetSiteDashboardTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getSiteDashboard',
        {
            description:
                'Read Wi-Fi, device traffic, wireless retry/drop averages, switch and current PoE summaries. Reports partial or unavailable sections explicitly. Uses a bounded window and at most 50 devices per list; omits per-port and historical series. Does not run scans or speed tests. Wi-Fi traffic is KB, device traffic MB, switch traffic bytes and PoE power watts, as reported by the controller.',
            inputSchema: dashboardSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getSiteDashboard', async (options) => toToolResult(await client.getSiteDashboard(options)))
    );
}
