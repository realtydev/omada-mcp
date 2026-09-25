import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const setSsidEnableSchema = z.object({
    siteId: z.string().min(1).optional(),
    ssidId: z.string().min(1, 'ssidId is required. Use getSsidList to get available SSID IDs.'),
    enable: z.boolean().describe('true to enable the SSID, false to disable it'),
});

export function registerSetSsidEnableTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setSsidEnable',
        {
            description:
                'Enable or disable an SSID (wireless network) network-wide. Requires ssidId (from getSsidList). ' +
                "This is not part of the documented Open API — it was confirmed by capturing the controller's own web UI " +
                'network traffic, since neither PUT/PATCH on the SSID resource itself nor its update-basic-config ' +
                'sub-endpoint honors an ssidEnable field.',
            inputSchema: setSsidEnableSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('setSsidEnable', async ({ siteId, ssidId, enable }) => toToolResult(await client.setSsidEnable(ssidId, enable, siteId)))
    );
}
