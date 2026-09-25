import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const createPortForwardSchema = z.object({
    siteId: z.string().min(1).optional(),
    rule: z
        .record(z.unknown())
        .describe(
            'Port forwarding rule object, e.g. { name, status, dMZ: false, externalPort: "59999", ' +
                'forwardIp: "192.168.0.253", forwardPort: "59999", protocol: 1, from: 0, ' +
                'interfaceWanPortId: ["<wan-port-id>"], virtualWanId: [], featureDescription: [] }. ' +
                "protocol: 0 = All, 1 = TCP, 2 = UDP. interfaceWanPortId values come from getInternetInfo's " +
                'wanPortSettings. Use getPortForwardingStatus(type: "User") first to see existing rule shapes.'
        ),
});

export function registerCreatePortForwardTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'createPortForward',
        {
            description: 'Create a port forwarding rule for a site. Use getPortForwardingStatus(type: "User") first to see the expected rule shape.',
            inputSchema: createPortForwardSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('createPortForward', async ({ siteId, rule }) => toToolResult(await client.createPortForward(rule, siteId)))
    );
}
