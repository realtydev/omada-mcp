import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { portWriteOptions, switchWriteOptionsSchema } from '../utils/switch-port-safety.js';

const updateSwitchPortSchema = z
    .object({
        ...switchWriteOptionsSchema.shape,
        siteId: z.string().min(1).optional(),
        switchMac: z.string().min(1, 'switchMac is required'),
        portId: z.string().min(1, 'portId is required'),
        profileId: z.string().min(1).optional().describe('LAN profile ID to assign'),
        poe: z.boolean().optional().describe('Enable or disable PoE'),
    })
    .strict()
    .refine(
        (value) => Number(value.profileId !== undefined) + Number(value.poe !== undefined) === 1,
        'Supply one profileId or poe setting per call.'
    );

export function registerUpdateSwitchPortTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'updateSwitchPort',
        {
            description:
                'Change one physical switch port profileId or PoE setting through the guarded dedicated endpoint. Supports dryRun previews and readback. Generic speed, STP, isolation and combined patches have no verified Open API contract.',
            inputSchema: updateSwitchPortSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('updateSwitchPort', async ({ siteId, switchMac, portId, dryRun, allowDisruption, ...data }) => {
            const options = portWriteOptions(dryRun, allowDisruption);
            return toToolResult(
                await (options
                    ? client.updateSwitchPort(switchMac, portId, data, siteId, options)
                    : client.updateSwitchPort(switchMac, portId, data, siteId))
            );
        })
    );
}
