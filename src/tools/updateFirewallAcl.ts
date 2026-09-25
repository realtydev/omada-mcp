import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const updateFirewallAclSchema = z.object({
    siteId: z.string().min(1).optional(),
    aclId: z.string().min(1, 'aclId is required'),
    rule: z
        .record(z.unknown())
        .describe(
            'Firewall ACL rule object (fields vary by controller version; use listFirewallAcls to see the existing rule shape). ' +
                'This is a full replace, so pass the complete rule (as returned by listFirewallAcls) with only the field(s) changed.'
        ),
});

export function registerUpdateFirewallAclTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'updateFirewallAcl',
        {
            description:
                'Update an existing firewall ACL rule by its ID, without deleting and recreating it. ' +
                'Use listFirewallAcls first to get the current rule shape and ID.',
            inputSchema: updateFirewallAclSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('updateFirewallAcl', async ({ siteId, aclId, rule }) => toToolResult(await client.updateFirewallAcl(aclId, rule, siteId)))
    );
}
