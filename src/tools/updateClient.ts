import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { clientUpdateSchema } from '../utils/client-update-schema.js';

const updateClientSchema = clientUpdateSchema.safeExtend({
    siteId: z.string().min(1).optional(),
    clientMac: z.string().min(1, 'clientMac is required'),
    dryRun: z.boolean().optional().describe('Validate and preview all requests without changing the client'),
});

export function registerUpdateClientTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'updateClient',
        {
            description:
                'Update client display name, fixed IPv4 address (empty disables), or rate limits. ' +
                'Custom limits support kbps/Mbps units. Independent writes can partially succeed; use dryRun to preview first.',
            inputSchema: updateClientSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('updateClient', async ({ siteId, clientMac, dryRun, ...data }) =>
            toToolResult(await client.updateClient(clientMac, data, siteId, dryRun))
        )
    );
}
