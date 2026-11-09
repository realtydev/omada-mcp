import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { networkDiagnosisOptionsSchema } from '../omadaClient/networkDiagnosis.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
export function registerDiagnoseNetworkTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'diagnoseNetwork',
        {
            description:
                'Collect one bounded read-only network diagnosis: managed devices/clients, WAN, Wi-Fi, full switch-port coverage, inherited VLANs, topology, RF planning and recent events/alerts. Evidence-linked observations distinguish controller snapshots, candidates, historical incidents and later loop clears. Unknown evidence remains explicit. No health score, scans, reconnects, failover tests or configuration changes. Requires read access to devices, clients, wireless, switching, network and monitoring categories.',
            inputSchema: networkDiagnosisOptionsSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('diagnoseNetwork', async (args) => toToolResult(await client.diagnoseNetwork(args)))
    );
}
