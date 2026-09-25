import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const getGatewayWanStatusSchema = z.object({
    siteId: z.string().min(1).optional(),
    gatewayMac: z.string().min(1, 'gatewayMac is required'),
});

export function registerGetGatewayWanStatusTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getGatewayWanStatus',
        {
            description:
                'Get the live status of each gateway WAN port: link and internet state, IPv4 address, gateway, DNS, latency and loss. Use the port number with setGatewayWanConnect.',
            inputSchema: getGatewayWanStatusSchema.shape,
        },
        wrapToolHandler('getGatewayWanStatus', async ({ gatewayMac, siteId }) => toToolResult(await client.getGatewayWanStatus(gatewayMac, siteId)))
    );
}
