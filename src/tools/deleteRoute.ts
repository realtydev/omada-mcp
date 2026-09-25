import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const deleteRouteSchema = z.object({
    siteId: z.string().min(1).optional(),
    routeId: z.string().min(1, 'routeId is required'),
});

export function registerDeleteRouteTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'deleteRoute',
        {
            description: 'Delete a static route by its ID.',
            inputSchema: deleteRouteSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('deleteRoute', async ({ routeId, siteId }) => toToolResult(await client.deleteRoute(routeId, siteId)))
    );
}
