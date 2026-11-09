import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';
import { networkDiagnosticSchema } from './getTrafficHistory.js';

export function registerDiagnoseWifiTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'diagnoseWifi',
        {
            description:
                'Collect channel distribution, interference and timestamped retry/drop evidence. Optional apMac adds mesh evidence. Reports missing bands, partial results and truncation; never starts scans or changes radios.',
            inputSchema: networkDiagnosticSchema
                .extend({
                    apMac: z
                        .string()
                        .regex(/^(?:[\da-f]{12}|(?:[\da-f]{2}[:-]){5}[\da-f]{2})$/i)
                        .optional(),
                })
                .strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('diagnoseWifi', async (options) => toToolResult(await client.diagnoseWifi(options)))
    );
}
