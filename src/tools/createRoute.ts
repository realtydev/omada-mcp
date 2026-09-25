import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const createRouteSchema = z.object({
    siteId: z.string().min(1).optional(),
    route: z
        .record(z.unknown())
        .describe(
            'Static route object, e.g. { name, status, destinations: ["203.0.113.0/24"], routeType: 0, ' +
                'nextHopIp: "192.168.0.1", metric: "15" }. routeType 0 = Next Hop. Use listRoutes first to see existing route shapes.'
        ),
});

export function registerCreateRouteTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'createRoute',
        {
            description: 'Create a static route for a site. Use listRoutes first to see the expected route shape.',
            inputSchema: createRouteSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('createRoute', async ({ siteId, route }) => toToolResult(await client.createRoute(route, siteId)))
    );
}
