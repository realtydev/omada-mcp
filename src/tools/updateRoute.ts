import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const updateRouteSchema = z.object({
    siteId: z.string().min(1).optional(),
    routeId: z.string().min(1, 'routeId is required'),
    route: z
        .record(z.unknown())
        .describe(
            'Updated static route object, same shape as createRoute, e.g. { name, status, ' +
                'destinations: ["203.0.113.0/24"], routeType: 0, nextHopIp: "192.168.0.1", metric: "15" }.'
        ),
});

export function registerUpdateRouteTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'updateRoute',
        {
            description: 'Update an existing static route by its ID. Use listRoutes first to see the expected route shape.',
            inputSchema: updateRouteSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('updateRoute', async ({ siteId, routeId, route }) => toToolResult(await client.updateRoute(routeId, route, siteId)))
    );
}
