import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const setIpsSettingSchema = z.object({
    siteId: z.string().min(1).optional(),
    enable: z.boolean().describe('true to enable IDS/IPS on the gateway, false to disable it'),
    mode: z
        .enum(['IDS', 'IPS'])
        .optional()
        .describe(
            "Detection mode, per TP-Link's documented shape: 'IDS' reports/logs matching threats without blocking traffic; " +
                "'IPS' actively blocks the matching connection. Required by the controller when enabling."
        ),
    level: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
            'Detection level/sensitivity, per TP-Link\'s documented shape (e.g. "Low"/"Medium"/"High"). Required by the controller when enabling.'
        ),
    settings: z
        .record(z.unknown())
        .optional()
        .describe('Additional raw fields to merge into the request body (e.g. an allowList of exempted hosts/IPs), for anything not covered above.'),
});

export function registerSetIpsSettingTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setIpsSetting',
        {
            description:
                "Enable/disable and configure IDS/IPS (Intrusion Detection/Prevention) on a site's gateway. Pass `enable`, " +
                'and when enabling, `mode` (IDS = detect-and-log only, IPS = detect-and-block) and `level` (detection ' +
                "sensitivity) as documented by TP-Link for the Omada SDN Controller. Enabling can reduce the gateway's " +
                'maximum throughput — mention that trade-off to the user before turning it on. Not all gateway models ' +
                'support IDS/IPS; mirroring getIpsSetting, that case reports `{ supported: false, reason }` instead of ' +
                'throwing (confirmed live: some models report `supported: true` from getIpsSetting yet still reject ' +
                'enabling this way — the read and write capability signals do not always agree, so treat write-side ' +
                "rejection as authoritative). The exact `mode`/`level`/allow-list field names follow TP-Link's published " +
                'API shape but could not be verified against a live enabled-state response during development, since no ' +
                'gateway available for testing would accept being enabled — pass extra fields via `settings` if the ' +
                'documented names are rejected, and check the resulting error message for the field the controller expects.',
            inputSchema: setIpsSettingSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('setIpsSetting', async ({ siteId, enable, mode, level, settings }) =>
            toToolResult(
                await client.setIpsSetting(
                    {
                        enable,
                        ...(mode !== undefined && { mode }),
                        ...(level !== undefined && { level }),
                        ...settings,
                    },
                    siteId
                )
            )
        )
    );
}
