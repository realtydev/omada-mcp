import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const emptySchema = z.object({});

export function registerListSitesTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'listSites',
        {
            description:
                'List accessible sites and their IDs. Call this first when OMADA_SITE_ID is not configured; pass a returned site ID to site-scoped tools.',
            inputSchema: emptySchema.shape,
        },
        wrapToolHandler('listSites', async () => toToolResult(await client.listSites()))
    );
}
