import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { ssidUpdateSchema } from '../utils/ssid-update-schema.js';

const updateSsidSchema = z.object({
    wlanId: z.string().min(1, 'wlanId is required. Use getWlanGroupList to get available WLAN group IDs.'),
    ssidId: z.string().min(1, 'ssidId is required. Use getSsidList to get available SSID IDs.'),
    siteId: z.string().min(1).optional(),
    dryRun: z.boolean().optional().describe('Preview redacted changes without writing. Omit or use false to apply and verify.'),
    ssid: ssidUpdateSchema.describe(
        "SSID basic-config fields, same shape as getSsidDetail's basic fields (name, band, security, broadcast, vlanEnable, " +
            'vlanId, pskSetting, entSetting, ppskSetting, mloEnable, pmfMode, enable11r, hidePwd, greEnable, vlanSetting, ' +
            'prohibitWifiShare). Partial changes preserve current documented basic fields and nested security siblings. ' +
            'Supply required fields omitted by the controller detail response, such as mloEnable; they are never guessed. ' +
            'If the controller hides the current WPA-Personal password, supply the real pskSetting.securityKey to preserve it. ' +
            'Does NOT control ssidEnable (use setSsidEnable to enable/disable the SSID) and does not touch schedule, rate ' +
            'limit/control, MAC filter, multicast, or Hotspot 2.0 settings.'
    ),
});

export function registerUpdateSsidTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'updateSsid',
        {
            description:
                "Update an SSID's basic configuration (name, band, security, VLAN, PSK, PMF mode, 802.11r, etc). " +
                'Requires wlanId (from getWlanGroupList) and ssidId (from getSsidList). To enable/disable the SSID, use ' +
                'setSsidEnable instead. Reads existing settings, preserves siblings, and verifies requested fields after applying once. ' +
                'Use dryRun=true for a redacted preview; a lost acknowledgement returns written="unknown" and is never replayed. Verified complete open/enterprise basic edits may return a secret-free rollbackReceipt; PSK/PPSK changes do not.',
            inputSchema: updateSsidSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('updateSsid', async ({ wlanId, ssidId, siteId, ssid, dryRun }) =>
            toToolResult(await (dryRun ? client.updateSsid(wlanId, ssidId, ssid, siteId, true) : client.updateSsid(wlanId, ssidId, ssid, siteId)))
        )
    );
}
