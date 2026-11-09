import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { networkDiagnosticSchema } from './getTrafficHistory.js';

export function registerDiagnoseWanTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'diagnoseWan',
        {
            description:
                'Collect gateway WAN link/internet status, current health and bounded site-wide ISP history. Preserves timestamp/unit evidence and partial failures. Does not run speed tests, reconnect WANs or change failover.',
            inputSchema: networkDiagnosticSchema
                .extend({ gatewayMac: z.string().regex(/^(?:[\da-f]{12}|(?:[\da-f]{2}[:-]){5}[\da-f]{2})$/i) })
                .strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('diagnoseWan', async (options) => toToolResult(await client.diagnoseWan(options)))
    );
}
