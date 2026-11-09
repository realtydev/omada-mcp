import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const adoptDeviceSchema = z.object({
    siteId: z.string().min(1).optional(),
    deviceMac: z.string().min(1, 'deviceMac is required'),
    username: z.string().min(1).max(64).optional().describe('Existing device account username, when required for adoption'),
    password: z.string().min(1).max(64).optional().describe('Existing device account password, when required for adoption'),
});

export function registerAdoptDeviceTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'adoptDevice',
        {
            description: 'Adopt a pending device by its MAC address into the site.',
            inputSchema: adoptDeviceSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('adoptDevice', async ({ deviceMac, siteId, username, password }) =>
            toToolResult(await client.adoptDevice(deviceMac, siteId, { username, password }))
        )
    );
}
