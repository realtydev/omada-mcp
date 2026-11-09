import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerLocateDeviceTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'locateDevice',
        {
            description: 'Start or stop the identification LED on one device. This does not change the site LED policy.',
            inputSchema: z.object({ siteId: z.string().min(1).optional(), deviceMac: z.string().min(1), enable: z.boolean() }).strict(),
            annotations: { destructiveHint: true },
        },
        wrapToolHandler('locateDevice', async ({ deviceMac, enable, siteId }) => toToolResult(await client.locateDevice(deviceMac, enable, siteId)))
    );
}
