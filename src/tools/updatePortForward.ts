import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const updatePortForwardSchema = z.object({
    siteId: z.string().min(1).optional(),
    ruleId: z.string().min(1, 'ruleId is required'),
    rule: z.record(z.unknown()).describe('Updated port forwarding rule object, same shape as createPortForward.'),
});

export function registerUpdatePortForwardTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'updatePortForward',
        {
            description:
                'Update an existing port forwarding rule by its ID. Use getPortForwardingStatus(type: "User") first to see the expected rule shape.',
            inputSchema: updatePortForwardSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('updatePortForward', async ({ siteId, ruleId, rule }) => toToolResult(await client.updatePortForward(ruleId, rule, siteId)))
    );
}
