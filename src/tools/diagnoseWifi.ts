import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { wifiAuditOptionsSchema } from '../omadaClient/wifiAudit.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerDiagnoseWifiTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'diagnoseWifi',
        {
            description:
                'Collect a bounded read-only Wi-Fi site audit from dashboard, AP radio configuration/metrics and saved RF results. Missing, stale and truncated evidence remains explicit; no scan or configuration change is started. Save snapshot and pass it as baseline for a comparable radio-configuration diff, not a performance-improvement claim.',
            inputSchema: wifiAuditOptionsSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('diagnoseWifi', async (options) => toToolResult(await client.diagnoseWifi(options)))
    );
}
