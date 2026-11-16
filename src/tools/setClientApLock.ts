import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { clientApLockSchema, clientLockMacSchema } from '../utils/client-update-schema.js';

export function registerSetClientApLockTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setClientApLock',
        {
            description:
                'Lock a wireless client to explicitly supported, connected APs, or unlock it. Previews by default; applying may disconnect the client or restrict roaming. Reads current state, rejects preflight drift and verifies configuration after one write.',
            inputSchema: clientApLockSchema
                .safeExtend({ clientMac: clientLockMacSchema, siteId: z.string().min(1).optional(), dryRun: z.boolean().default(true) })
                .strict(),
            annotations: { destructiveHint: true },
        },
        wrapToolHandler('setClientApLock', async ({ clientMac, siteId, dryRun, ...settings }) =>
            toToolResult(await client.setClientApLock(clientMac, settings, siteId, dryRun))
        )
    );
}
