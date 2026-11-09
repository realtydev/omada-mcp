import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const getApAfcStatusSchema = z.object({
    siteId: z.string().min(1).optional(),
    apMac: z.string().min(1, 'apMac is required').describe('AP MAC address, like AA-BB-CC-DD-EE-FF'),
});

export function registerGetApAfcStatusTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getApAfcStatus',
        {
            description:
                'Read Automated Frequency Coordination (AFC) status for a supported 6 GHz AP. Requires compatible controller and AP firmware; does not enable AFC or change regulatory settings.',
            inputSchema: getApAfcStatusSchema.shape,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getApAfcStatus', async ({ apMac, siteId }) => toToolResult(await client.getApAfcStatus(apMac, siteId)))
    );
}
