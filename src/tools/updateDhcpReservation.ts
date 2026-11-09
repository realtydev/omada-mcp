import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { dhcpReservationUpdateSchema, reservationMacSchema } from './dhcpReservationSchemas.js';

const schema = z
    .object({
        siteId: z.string().min(1).optional(),
        mac: reservationMacSchema,
        settings: dhcpReservationUpdateSchema.describe('Only fields to change; current required and optional writable fields are preserved'),
        dryRun: z.boolean().optional().default(false).describe('Preview the request and changes without writing'),
    })
    .strict();

export function registerUpdateDhcpReservationTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'updateDhcpReservation',
        {
            description:
                'Update an existing DHCP reservation by MAC, preserving other writable fields. Supports dryRun and bounded read-back verification; unchanged settings produce no write. Inspect verification.status for unconfirmed outcomes.',
            inputSchema: schema,
            annotations: { destructiveHint: true },
        },
        wrapToolHandler('updateDhcpReservation', async ({ mac, settings, siteId, dryRun }) =>
            toToolResult(await client.updateDhcpReservation(mac, settings, siteId, dryRun))
        )
    );
}
