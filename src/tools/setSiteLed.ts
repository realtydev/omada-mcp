import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerSetSiteLedTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setSiteLed',
        {
            description: 'Enable or disable the site-wide LED policy. Affects all devices configured to follow site settings.',
            inputSchema: z.object({ siteId: z.string().min(1).optional(), enable: z.boolean() }).strict(),
            annotations: { destructiveHint: true },
        },
        wrapToolHandler('setSiteLed', async ({ enable, siteId }) => toToolResult(await client.setSiteLed(enable, siteId)))
    );
}
