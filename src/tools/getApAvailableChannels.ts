import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const getApAvailableChannelsSchema = z.object({
    siteId: z.string().min(1).optional(),
    apMac: z.string().min(1, 'apMac is required').describe('AP MAC address, like AA-BB-CC-DD-EE-FF'),
});

export function registerGetApAvailableChannelsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getApAvailableChannels',
        {
            description:
                'Read available AP radio channels with their controller channel indices. Use these indices when calling setApRadio; channel indices may differ from Wi-Fi channel numbers.',
            inputSchema: getApAvailableChannelsSchema.shape,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getApAvailableChannels', async ({ apMac, siteId }) => toToolResult(await client.getApAvailableChannels(apMac, siteId)))
    );
}
