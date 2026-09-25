import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const updateSsidSchema = z.object({
    wlanId: z.string().min(1, 'wlanId is required. Use getWlanGroupList to get available WLAN group IDs.'),
    ssidId: z.string().min(1, 'ssidId is required. Use getSsidList to get available SSID IDs.'),
    siteId: z.string().min(1).optional(),
    ssid: z
        .record(z.unknown())
        .describe(
            "SSID basic-config fields, same shape as getSsidDetail's basic fields (name, band, security, broadcast, vlanEnable, " +
                'vlanId, pskSetting, entSetting, ppskSetting, mloEnable, pmfMode, enable11r, hidePwd, greEnable, vlanSetting, ' +
                'prohibitWifiShare). Required by the controller on every call: band, broadcast, enable11r, guestNetEnable, ' +
                'mloEnable, name, pmfMode, security, vlanEnable — fetch getSsidDetail first and include these even if unchanged. ' +
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
                'setSsidEnable instead — this tool does not support that.',
            inputSchema: updateSsidSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('updateSsid', async ({ wlanId, ssidId, siteId, ssid }) => toToolResult(await client.updateSsid(wlanId, ssidId, ssid, siteId)))
    );
}
