import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { portWriteOptions, switchPortListSchema, switchWriteOptionsSchema } from '../utils/switch-port-safety.js';

const batchSetSwitchPortProfileSchema = z.object({
    ...switchWriteOptionsSchema.shape,
    siteId: z.string().min(1).optional(),
    switchMac: z.string().min(1, 'switchMac is required'),
    portList: switchPortListSchema,
    profileOverrideEnable: z.boolean().describe('Enable or disable profile override on all specified ports'),
});

export function registerBatchSetSwitchPortProfileTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'batchSetSwitchPortProfile',
        {
            description: 'Batch enable or disable profile override on multiple switch ports.',
            inputSchema: batchSetSwitchPortProfileSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('batchSetSwitchPortProfile', async ({ switchMac, portList, profileOverrideEnable, siteId, dryRun, allowDisruption }) => {
            const options = portWriteOptions(dryRun, allowDisruption);
            return toToolResult(
                await (options
                    ? client.batchSetSwitchPortProfile(switchMac, portList, profileOverrideEnable, siteId, options)
                    : client.batchSetSwitchPortProfile(switchMac, portList, profileOverrideEnable, siteId))
            );
        })
    );
}
