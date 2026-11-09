import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { networkDiagnosticSnapshotSchema } from '../omadaClient/networkDiagnosticComparison.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export const networkDiagnosticSchema = z.object({
    siteId: z.string().min(1).optional(),
    baseline: networkDiagnosticSnapshotSchema
        .optional()
        .describe(
            'A prior snapshot from this same workflow, controller, site and device; compares matching windows/evidence without inferring totals.'
        ),
    start: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Window start in epoch seconds; defaults to one hour before end. Maximum window: 24 hours.'),
    end: z.number().int().nonnegative().optional().describe('Window end in epoch seconds; defaults to now.'),
    maxSamples: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe('Maximum combined historical samples per section; default 144. Truncation is explicit.'),
});
export function registerGetTrafficHistoryTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getTrafficHistory',
        {
            description:
                'Read bounded AP and switch traffic time series with original timestamps, MB units, available/returned counts and explicit truncation. Optional baseline compares aligned sample observations without traffic deltas or totals. Does not change settings.',
            inputSchema: networkDiagnosticSchema.strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getTrafficHistory', async (options) => toToolResult(await client.getTrafficHistory(options)))
    );
}
