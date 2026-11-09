import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { reservationMacSchema } from './dhcpReservationSchemas.js';

const schema = z
    .object({
        siteId: z.string().min(1).optional(),
        mac: reservationMacSchema,
        dryRun: z.boolean().optional().default(false).describe('Preview deletion without writing'),
    })
    .strict();

export function registerDeleteDhcpReservationTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'deleteDhcpReservation',
        {
            description:
                'Delete an existing DHCP reservation by MAC. Supports dryRun and verifies that the reservation disappears. Inspect verification.status for unconfirmed outcomes.',
            inputSchema: schema,
            annotations: { destructiveHint: true },
        },
        wrapToolHandler('deleteDhcpReservation', async ({ mac, siteId, dryRun }) =>
            toToolResult(await client.deleteDhcpReservation(mac, siteId, dryRun))
        )
    );
}
