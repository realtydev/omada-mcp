import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { dhcpSettingsSchema } from './lanNetworkSchemas.js';

const createLanNetworkSchema = z.object({
    siteId: z.string().min(1).optional(),
    name: z.string().min(1, 'Network name is required'),
    vlan: z.number().int().describe('VLAN ID'),
    gatewaySubnet: z.string().min(1).describe('Gateway and subnet in CIDR notation (e.g. "192.168.10.1/24")'),
    purpose: z.number().int().describe('Network purpose (1 = interface)'),
    igmpSnoopEnable: z.boolean().describe('Whether IGMP snooping is enabled'),
    interfaceIds: z.array(z.string()).min(1).describe('Gateway LAN port IDs this network is bound to (from "Check WAN/LAN status").'),
    dhcpSettingsVO: dhcpSettingsSchema.describe('DHCP server settings'),
});

export function registerCreateLanNetworkTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'createLanNetwork',
        {
            description: 'Create a new LAN network with VLAN, gateway/subnet, and DHCP settings.',
            inputSchema: createLanNetworkSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('createLanNetwork', async ({ siteId, ...data }) => toToolResult(await client.createLanNetwork(data, siteId)))
    );
}
