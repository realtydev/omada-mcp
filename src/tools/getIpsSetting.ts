import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OmadaClient } from '../omadaClient/index.js';
import { siteInputSchema, toToolResult, wrapToolHandler } from '../server/common.js';

export function registerGetIpsSettingTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'getIpsSetting',
        {
            description:
                "Get IDS/IPS (Intrusion Prevention System / threat protection) status for a site's gateway: whether it is " +
                'enabled, and if so its mode (detect-only vs. detect-and-block) and detection level. Use this to disambiguate ' +
                'an empty getThreatList result — zero threats can mean nothing was detected, or that IDS/IPS is off entirely. ' +
                "Some gateway models don't support IDS/IPS at all; in that case the result reports `supported: false` with a " +
                'reason instead of an error.',
            inputSchema: siteInputSchema.shape,
        },
        wrapToolHandler('getIpsSetting', async ({ siteId }) => toToolResult(await client.getIpsSetting(siteId)))
    );
}
