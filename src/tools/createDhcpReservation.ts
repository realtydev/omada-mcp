import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { dhcpReservationConfigSchema } from './dhcpReservationSchemas.js';

const schema = z
    .object({
        siteId: z.string().min(1).optional(),
        reservation: dhcpReservationConfigSchema,
        dryRun: z.boolean().optional().default(false).describe('Preview the request and changes without writing'),
    })
    .strict();

export function registerCreateDhcpReservationTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'createDhcpReservation',
        {
            description:
                'Create a DHCP reservation after checking for an existing MAC. Supports dryRun and bounded read-back verification. Inspect verification.status; unknown or mismatch means completion is not confirmed. Verified changes with complete stable identity/configuration may return a rollbackReceipt.',
            inputSchema: schema,
            annotations: { destructiveHint: true },
        },
        wrapToolHandler('createDhcpReservation', async ({ reservation, siteId, dryRun }) =>
            toToolResult(await client.createDhcpReservation(reservation, siteId, dryRun))
        )
    );
}
