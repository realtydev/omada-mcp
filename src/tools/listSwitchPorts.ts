import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const listSwitchPortsSchema = z.object({
    siteId: z.string().min(1).optional(),
    switchMac: z.string().min(1).optional(),
});

export function registerListSwitchPortsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'listSwitchPorts',
        {
            description:
                'List switch port telemetry including link state, speed, duplex, traffic, STP, LLDP and PoE. ' +
                'Optionally filter by switch MAC. Supports Agile Series switches through the site-wide PoE port endpoint.',
            inputSchema: listSwitchPortsSchema.shape,
        },
        wrapToolHandler('listSwitchPorts', async ({ switchMac, siteId }) => toToolResult(await client.listSwitchPorts(switchMac, siteId)))
    );
}
