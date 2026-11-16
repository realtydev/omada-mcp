import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { securityDiagnosticOptionsSchema } from '../omadaClient/securityDiagnostics.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerDiagnoseSecurityTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'diagnoseSecurity',
        {
            description:
                'Read bounded saved rogue-AP, WIDS and site-local unarchived threat evidence. The epoch-second window applies only to threats (default last 24 hours, maximum 24 hours); rogue/WIDS reads are controller snapshots. Reads page 1 of each source, reports missing/unsupported/partial evidence and native timestamps explicitly. No scan, containment, acknowledgement or protection-setting change. Empty results do not establish security.',
            inputSchema: securityDiagnosticOptionsSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('diagnoseSecurity', async (args) => toToolResult(await client.diagnoseSecurity(args)))
    );
}
