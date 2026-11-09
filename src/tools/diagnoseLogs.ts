import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const diagnoseLogsSchema = z
    .object({
        siteId: z.string().min(1).optional(),
        timeStart: z.number().int().nonnegative().optional().describe('Window start, epoch milliseconds; defaults to 24 hours before timeEnd.'),
        timeEnd: z.number().int().nonnegative().optional().describe('Window end, epoch milliseconds; defaults to now.'),
        pageSize: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .default(100)
            .describe('Maximum records per source, fetched from page 1; defaults to 100, max 200.'),
    })
    .strict()
    .refine((value) => value.timeStart === undefined || value.timeEnd === undefined || value.timeStart <= value.timeEnd, {
        message: 'timeStart must be at or before timeEnd.',
        path: ['timeStart'],
    });

export function registerDiagnoseLogsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'diagnoseLogs',
        {
            description:
                'Read a bounded snapshot of site events and alerts for one explicit time window (default: last 24 hours). Reports per-source errors, total rows, truncation and completeness; an empty result is not a health score.',
            inputSchema: diagnoseLogsSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('diagnoseLogs', async ({ siteId, timeStart, timeEnd, pageSize }) =>
            toToolResult(await client.diagnoseLogs(siteId, timeStart, timeEnd, pageSize))
        )
    );
}
