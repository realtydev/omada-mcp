import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const diagnoseClientSchema = z
    .object({
        clientMac: z.string().regex(/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})$/i, 'A full client MAC address is required.'),
        siteId: z.string().min(1).optional(),
        timeStart: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('History window start, epoch milliseconds; defaults to 24 hours before timeEnd.'),
        timeEnd: z.number().int().nonnegative().optional().describe('History window end, epoch milliseconds; defaults to now.'),
    })
    .strict()
    .refine((value) => value.timeStart === undefined || value.timeEnd === undefined || value.timeStart <= value.timeEnd, {
        message: 'timeStart must be at or before timeEnd.',
        path: ['timeStart'],
    });

export function registerDiagnoseClientTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'diagnoseClient',
        {
            description:
                'Collect current client attachment, device inventory, topology path and association history. Reports failed or missing evidence, truncated history and topology staleness explicitly; does not infer a healthy connection from missing data. Topology requires web UI credentials.',
            inputSchema: diagnoseClientSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('diagnoseClient', async ({ clientMac, siteId, timeStart, timeEnd }) =>
            toToolResult(await client.diagnoseClient(clientMac, siteId, timeStart, timeEnd))
        )
    );
}
