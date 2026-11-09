import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { portWriteOptions, switchPortNameSchema, switchWriteOptionsSchema } from '../utils/switch-port-safety.js';

const setSwitchPortNameSchema = z.object({
    ...switchWriteOptionsSchema.shape,
    siteId: z.string().min(1).optional(),
    switchMac: z.string().min(1, 'switchMac is required'),
    port: z.number().int().min(1, 'port number is required'),
    name: switchPortNameSchema,
});

export function registerSetSwitchPortNameTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setSwitchPortName',
        {
            description: 'Set the name of a single switch port (1-128 characters).',
            inputSchema: setSwitchPortNameSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('setSwitchPortName', async ({ switchMac, port, name, siteId, dryRun, allowDisruption }) => {
            const options = portWriteOptions(dryRun, allowDisruption);
            return toToolResult(
                await (options
                    ? client.setSwitchPortName(switchMac, port, name, siteId, options)
                    : client.setSwitchPortName(switchMac, port, name, siteId))
            );
        })
    );
}
