import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const getClientHistorySchema = z.object({
    siteId: z.string().min(1).optional(),
    clientMac: z.string().min(1, 'clientMac is required').describe('Client MAC address, like AA-BB-CC-DD-EE-FF'),
    timeStart: z.number().int().optional().describe('Start of time range, epoch milliseconds (default: 7 days before timeEnd)'),
    timeEnd: z.number().int().optional().describe('End of time range, epoch milliseconds (default: now)'),
    roamTimeline: z
        .boolean()
        .optional()
        .default(false)
        .describe('Also return roams: consecutive wireless sessions on different APs with a gap of at most maxGapSeconds (default: false)'),
    maxGapSeconds: z
        .number()
        .min(0)
        .optional()
        .describe('Largest gap in seconds between one session ending and the next starting that still counts as a roam (default: 60)'),
});

export function registerGetClientHistoryTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getClientHistory',
        {
            description:
                "Get a client's association sessions (start, end, duration, AP, SSID) over a time range, oldest first. With roamTimeline, also lists roams between APs.",
            inputSchema: getClientHistorySchema.shape,
        },
        wrapToolHandler('getClientHistory', async ({ siteId, clientMac, timeStart, timeEnd, roamTimeline, maxGapSeconds }) =>
            toToolResult(await client.getClientHistory({ siteId, clientMac, timeStart, timeEnd, roamTimeline, maxGapSeconds }))
        )
    );
}
