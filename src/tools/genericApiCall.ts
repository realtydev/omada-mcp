import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const genericApiCallSchema = z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(1, 'path is required (e.g. /sites/{siteId}/firewall)'),
    version: z.enum(['v1', 'v2']).optional().default('v1'),
    body: z.record(z.unknown()).optional(),
    queryParams: z.record(z.unknown()).optional(),
});

export function registerGenericApiCallTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'genericApiCall',
        {
            description:
                'Execute an arbitrary call against the public Omada Open API. Use this for any Open API endpoint not covered ' +
                'by other tools. Path is relative (e.g. "/sites/{siteId}/firewall"). The omadacId prefix is added automatically. ' +
                'Note: this only reaches the Open API — some settings (e.g. firewall ACLs, IP groups, static routes on ' +
                'controllers like the OC200) are exposed solely through the internal web UI API and will 404 here; use the ' +
                'dedicated tools (listFirewallAcls, createFirewallAcl, listIpGroups, etc.) for those instead.',
            inputSchema: genericApiCallSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('genericApiCall', async ({ method, path, version, body, queryParams }) =>
            toToolResult(await client.genericApiCall(method, path, version, body, queryParams))
        )
    );
}
