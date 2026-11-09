import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { portWriteOptions, switchWriteOptionsSchema } from '../utils/switch-port-safety.js';

const setSwitchPortProfileOverrideSchema = z.object({
    ...switchWriteOptionsSchema.shape,
    siteId: z.string().min(1).optional(),
    switchMac: z.string().min(1, 'switchMac is required'),
    port: z.number().int().min(1, 'port number is required'),
    profileOverrideEnable: z.boolean().describe('Enable or disable profile override'),
});

export function registerSetSwitchPortProfileOverrideTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setSwitchPortProfileOverride',
        {
            description: 'Enable or disable profile override on a single switch port.',
            inputSchema: setSwitchPortProfileOverrideSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('setSwitchPortProfileOverride', async ({ switchMac, port, profileOverrideEnable, siteId, dryRun, allowDisruption }) => {
            const options = portWriteOptions(dryRun, allowDisruption);
            return toToolResult(
                await (options
                    ? client.setSwitchPortProfileOverride(switchMac, port, profileOverrideEnable, siteId, options)
                    : client.setSwitchPortProfileOverride(switchMac, port, profileOverrideEnable, siteId))
            );
        })
    );
}
