import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerGetGatewayWanSpeedTestResultsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getGatewayWanSpeedTestResults',
        {
            description:
                'Read existing gateway WAN speed-test results and their controller status. Does not start a speed test or generate test traffic. Results may be empty or stale.',
            inputSchema: z.object({ siteId: z.string().min(1).optional(), gatewayMac: z.string().min(1) }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getGatewayWanSpeedTestResults', async ({ gatewayMac, siteId }) =>
            toToolResult(await client.getGatewayWanSpeedTestResults(gatewayMac, siteId))
        )
    );
}
