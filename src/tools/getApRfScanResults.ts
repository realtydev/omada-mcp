import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const getApRfScanResultsSchema = z.object({
    siteId: z.string().min(1).optional(),
    apMac: z.string().min(1, 'apMac is required').describe('AP MAC address, like AA-BB-CC-DD-EE-FF'),
});

export function registerGetApRfScanResultsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getApRfScanResults',
        {
            description: 'Read the latest AP RF scan results through Open API v2. Does not start a scan or interrupt wireless service.',
            inputSchema: getApRfScanResultsSchema.shape,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getApRfScanResults', async ({ apMac, siteId }) => toToolResult(await client.getApRfScanResults(apMac, siteId)))
    );
}
