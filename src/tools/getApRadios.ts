import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const getApRadiosSchema = z.object({
    siteId: z.string().min(1).optional(),
    apMac: z.string().min(1, 'apMac is required').describe('AP MAC address, like AA-BB-CC-DD-EE-FF'),
});

export function registerGetApRadiosTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getApRadios',
        {
            description:
                "Get an AP's radio configuration (per band: enabled, channel, frequency, channel width, tx power) and radio statistics (rx/tx packets, retries, drops, errors).",
            inputSchema: getApRadiosSchema.shape,
        },
        wrapToolHandler('getApRadios', async ({ apMac, siteId }) => toToolResult(await client.getApRadios(apMac, siteId)))
    );
}
