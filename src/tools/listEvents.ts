import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const listEventsSchema = z.object({
    siteId: z.string().min(1).optional(),
    page: z.number().int().min(1).optional().default(1).describe('Page number (default: 1)'),
    pageSize: z.number().int().min(1).max(1000).optional().default(10).describe('Page size (default: 10, max: 1000)'),
    timeStart: z.number().int().optional().describe('Start of time range, epoch milliseconds (default: 7 days before timeEnd)'),
    timeEnd: z.number().int().optional().describe('End of time range, epoch milliseconds (default: now)'),
});

export function registerListEventsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'listEvents',
        {
            description: 'List paginated events for a site (alerts, warnings, system events).',
            inputSchema: listEventsSchema.shape,
        },
        wrapToolHandler('listEvents', async ({ siteId, page, pageSize, timeStart, timeEnd }) =>
            toToolResult(await client.listEvents(siteId, page, pageSize, timeStart, timeEnd))
        )
    );
}
