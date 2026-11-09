import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apMacSchema } from '../omadaClient/apSsidOverride.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerGetApSsidOverridesTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getApSsidOverrides',
        {
            description:
                'Read one AP’s effective SSIDs and configured override flags. Passwords are always redacted. Internal web credentials are needed for configuration evidence omitted by the public API; effective reads remain available without them.',
            inputSchema: z.object({ apMac: apMacSchema, siteId: z.string().min(1).optional() }).strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getApSsidOverrides', async ({ apMac, siteId }) => toToolResult(await client.getApSsidOverrides(apMac, siteId)))
    );
}
