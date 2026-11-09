import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apMacSchema, apSsidOverrideUpdateSchema, ssidEntryIdSchema } from '../omadaClient/apSsidOverride.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerUpdateApSsidOverrideTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'updateApSsidOverride',
        {
            description:
                'Partially update one AP-specific SSID override by ssidEntryId. Defaults to a secret-redacted preview. Requires internal web configuration evidence to preserve active sibling name/password/VLAN overrides. Set dryRun:false to apply once, reject preflight drift, and verify all configured overrides. May disconnect clients on the affected SSID; does not change site-wide SSID settings.',
            inputSchema: z
                .object({
                    apMac: apMacSchema,
                    ssidEntryId: ssidEntryIdSchema,
                    settings: apSsidOverrideUpdateSchema,
                    siteId: z.string().min(1).optional(),
                    dryRun: z.boolean().default(true),
                })
                .strict(),
            annotations: { destructiveHint: true },
        },
        wrapToolHandler('updateApSsidOverride', async ({ apMac, ssidEntryId, settings, siteId, dryRun }) =>
            toToolResult(await client.updateApSsidOverride(apMac, ssidEntryId, settings, siteId, dryRun))
        )
    );
}
