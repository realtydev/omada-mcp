import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const listAlertsSchema = z.object({
    siteId: z.string().min(1).optional(),
    page: z.number().int().min(1).optional().default(1).describe('Page number (default: 1)'),
    pageSize: z.number().int().min(1).max(1000).optional().default(10).describe('Page size (default: 10, max: 1000)'),
    timeStart: z.number().int().optional().describe('Start of time range, epoch milliseconds (default: 7 days before timeEnd)'),
    timeEnd: z.number().int().optional().describe('End of time range, epoch milliseconds (default: now)'),
    module: z.enum(['System', 'Device', 'Client']).optional().describe('Filter alerts by module (default: all modules)'),
    resolved: z.boolean().optional().describe('Filter by resolved state (default: both resolved and unresolved)'),
});

export function registerListAlertsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'listAlerts',
        {
            description:
                'List paginated alerts for a site (e.g. device disconnects). Optionally filter by module (System, Device, Client) and resolved state.',
            inputSchema: listAlertsSchema.shape,
        },
        wrapToolHandler('listAlerts', async ({ siteId, page, pageSize, timeStart, timeEnd, module, resolved }) =>
            toToolResult(await client.listAlerts(siteId, page, pageSize, timeStart, timeEnd, module, resolved))
        )
    );
}
