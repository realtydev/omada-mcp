import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const capabilitiesSchema = z
    .object({
        siteId: z.string().trim().min(1).max(128).optional(),
        wlanId: z.string().trim().min(1).max(128).optional().describe('Supply with ssidId to inspect exactly one SSID; no site scan is performed.'),
        ssidId: z.string().trim().min(1).max(128).optional(),
    })
    .strict()
    .refine((value) => (value.wlanId === undefined) === (value.ssidId === undefined), 'Provide both wlanId and ssidId for SSID evidence.');

export function registerGetControllerCapabilitiesTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getControllerCapabilities',
        {
            description:
                'Read controller version/mode, configured API surfaces and shared live/bundled API catalogue evidence. ' +
                'Separates documented operations from tested controller/device support, and reports MSP execution limitations. ' +
                'Optionally inspect one explicit wlanId/ssidId for missing required fields such as mloEnable without exposing names or passwords. ' +
                'Does not change settings, scan radios, or probe every API operation.',
            inputSchema: capabilitiesSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('getControllerCapabilities', async (options) => toToolResult(await client.getControllerCapabilities(options)))
    );
}
