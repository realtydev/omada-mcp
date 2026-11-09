import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const schema = z.object({
    siteId: z.string().min(1).optional(),
    searchKey: z.string().min(1).optional().describe('Optional controller search across MAC, IP address and description'),
});

export function registerListDhcpReservationsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'listDhcpReservations',
        {
            description: 'List all DHCP reservations in a site, with automatic pagination and an optional search filter.',
            inputSchema: schema.shape,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('listDhcpReservations', async ({ siteId, searchKey }) => toToolResult(await client.listDhcpReservations(siteId, searchKey)))
    );
}
