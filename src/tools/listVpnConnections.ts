import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerListVpnConnectionsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'listVpnConnections',
        {
            description:
                'Read all pages of VPN connection status. Choose tunnel or ipsec for traditional status; s2s, server and client routes require vpnType. Empty success means no rows for this query; controller errors are preserved.',
            inputSchema: z.object({
                siteId: z.string().min(1).optional(),
                kind: z.enum(['tunnel', 'ipsec', 's2s', 'server', 'client']).default('tunnel'),
                vpnType: z
                    .number()
                    .int()
                    .min(0)
                    .max(5)
                    .optional()
                    .describe('Controller protocol code; required for s2s/server/client. For example, s2s IPsec uses 2.'),
            }),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('listVpnConnections', async (options) => toToolResult(await client.listVpnConnections(options)))
    );
}
