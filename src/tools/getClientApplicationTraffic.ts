import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { clientApplicationTrafficOptionsSchema } from '../omadaClient/clientApplicationTraffic.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerGetClientApplicationTrafficTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getClientApplicationTraffic',
        {
            description:
                'Read bounded application-traffic evidence for one client MAC and a past epoch-second window up to 24 hours. Reports DPI/logging settings, native counter fields and partial/unsupported evidence. Missing or empty traffic is not zero usage; no byte conversion, rate calculation, client fanout or setting change.',
            inputSchema: clientApplicationTrafficOptionsSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getClientApplicationTraffic', async (args) => toToolResult(await client.getClientApplicationTraffic(args)))
    );
}
