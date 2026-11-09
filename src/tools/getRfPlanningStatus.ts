import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { rfPlanningOptionsSchema } from '../omadaClient/rfPlanning.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerGetRfPlanningStatusTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getRfPlanningStatus',
        {
            description:
                'Read RF planning configuration, current status, successful-deployment evidence and one bounded history page. Optionally include a planningHistoryId for per-AP/radio details. Distinguishes unknown, denied, unavailable and unsupported evidence; never starts a scan or applies a plan. Native timestamps and status codes do not establish current RF health.',
            inputSchema: rfPlanningOptionsSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getRfPlanningStatus', async (args) => toToolResult(await client.getRfPlanningStatus(args)))
    );
}
