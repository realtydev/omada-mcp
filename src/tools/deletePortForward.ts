import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const deletePortForwardSchema = z.object({
    siteId: z.string().min(1).optional(),
    ruleId: z.string().min(1, 'ruleId is required'),
});

export function registerDeletePortForwardTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'deletePortForward',
        {
            description: 'Delete a port forwarding rule by its ID.',
            inputSchema: deletePortForwardSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('deletePortForward', async ({ ruleId, siteId }) => toToolResult(await client.deletePortForward(ruleId, siteId)))
    );
}
