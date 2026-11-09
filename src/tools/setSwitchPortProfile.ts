import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { portWriteOptions, switchWriteOptionsSchema } from '../utils/switch-port-safety.js';

const setSwitchPortProfileSchema = z.object({
    ...switchWriteOptionsSchema.shape,
    siteId: z.string().min(1).optional(),
    switchMac: z.string().min(1, 'switchMac is required'),
    port: z.number().int().min(1, 'port number is required'),
    profileId: z.string().min(1, 'profileId is required'),
});

export function registerSetSwitchPortProfileTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setSwitchPortProfile',
        {
            description: 'Assign a LAN profile to a single switch port.',
            inputSchema: setSwitchPortProfileSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('setSwitchPortProfile', async ({ switchMac, port, profileId, siteId, dryRun, allowDisruption }) => {
            const options = portWriteOptions(dryRun, allowDisruption);
            return toToolResult(
                await (options
                    ? client.setSwitchPortProfile(switchMac, port, profileId, siteId, options)
                    : client.setSwitchPortProfile(switchMac, port, profileId, siteId))
            );
        })
    );
}
