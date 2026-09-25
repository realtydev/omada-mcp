import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const updateWanPortSettingSchema = z.object({
    siteId: z.string().min(1).optional(),
    portSetting: z
        .record(z.unknown())
        .describe(
            'WAN port setting object for the write endpoint — this is NOT the same shape as an entry in ' +
                "getInternetInfo's wanPortSettings array; passing that read-model shape through unchanged will be " +
                'rejected. Use portUuid (not portId), proto (not protoType, e.g. "dhcp"), and for the DHCP client ' +
                'ipv4Dhcp.unicast: "on"/"off" (not unicastDhcp: bool). wanPortMacSetting.method is a string enum ' +
                '(e.g. "recover"), and wanPortIpv6Setting.enable is 0/1, not a bool. Only include the sub-object for ' +
                'the active proto (e.g. ipv4Dhcp when proto is "dhcp") — omit the other protocol sub-objects entirely ' +
                'rather than sending them empty, or the controller will reject the request citing unrelated fields ' +
                '(mssClampingType, subnetMask, userName, connectionMode, etc.) that belong to those unused protocols. ' +
                'Minimal example enabling unicast DHCP on a port: {"portDesc":"","portUuid":"<id>",' +
                '"wanPortMacSetting":{"portUuid":"<id>","method":"recover"},' +
                '"wanPortIpv4Setting":{"proto":"dhcp","ipv4Dhcp":{"unicast":"on","mtu":1500,"dhcpOptions":[]},' +
                '"vlanId":0,"qosTagEnable":false,"portDesc":"","portUuid":"<id>","supportQosTagEnable":true,' +
                '"supportInternetVlan":true},"wanPortIpv6Setting":{"enable":0,"portUuid":"<id>"}}'
        ),
});

export function registerUpdateWanPortSettingTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'updateWanPortSetting',
        {
            description:
                "Update a gateway WAN port's connection settings for a site (IPv4/IPv6/MAC config, e.g. the DHCP " +
                "client's unicast-renewal flag). The write payload uses different field names than getInternetInfo's " +
                'read model — see the portSetting parameter description for the exact shape and a working example. ' +
                'Does not connect/disconnect the port (use setGatewayWanConnect for that).',
            inputSchema: updateWanPortSettingSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('updateWanPortSetting', async ({ siteId, portSetting }) =>
            toToolResult(await client.updateWanPortSetting(portSetting, siteId))
        )
    );
}
