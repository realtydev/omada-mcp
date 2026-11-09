import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { portWriteOptions, switchPortListSchema, switchWriteOptionsSchema } from '../utils/switch-port-safety.js';

const batchSetSwitchPortStatusSchema = z.object({
    ...switchWriteOptionsSchema.shape,
    siteId: z.string().min(1).optional(),
    switchMac: z.string().min(1, 'switchMac is required'),
    portList: switchPortListSchema,
    status: z.number().int().min(0).max(1).describe('0=off, 1=on'),
});

export function registerBatchSetSwitchPortStatusTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'batchSetSwitchPortStatus',
        {
            description: 'Batch enable or disable multiple switch ports. 0=off, 1=on.',
            inputSchema: batchSetSwitchPortStatusSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('batchSetSwitchPortStatus', async ({ switchMac, portList, status, siteId, dryRun, allowDisruption }) => {
            const options = portWriteOptions(dryRun, allowDisruption);
            return toToolResult(
                await (options
                    ? client.batchSetSwitchPortStatus(switchMac, portList, status, siteId, options)
                    : client.batchSetSwitchPortStatus(switchMac, portList, status, siteId))
            );
        })
    );
}
