import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const executeApiOperationSchema = z
    .object({
        operationId: z.string().trim().min(1).max(256).describe('An operationId returned by searchApiOperations'),
        params: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Documented path and query parameters; controller ID is supplied automatically'),
        body: z.unknown().optional().describe('JSON request body matching describeApiOperation; binary and multipart uploads are unsupported'),
        dryRun: z
            .boolean()
            .optional()
            .describe('Writes default to a validated preview. Set false explicitly to send a write; read-only mode blocks writes.'),
    })
    .strict();

export function registerExecuteApiOperationTool(server: McpServer, client: OmadaClient, options: { readOnly?: boolean } = {}): void {
    const readOnly = options.readOnly === true;
    server.registerTool(
        'executeApiOperation',
        {
            description:
                'Validate and execute a discovered JSON Open API operation using the existing controller authentication and TLS checks. ' +
                'Inspect its schema first. Writes default to dry-run previews and do not provide dedicated-tool read-back verification. ' +
                (readOnly ? 'This server permits GET operations only.' : 'Prefer a dedicated tool when it provides previews or verification.'),
            inputSchema: executeApiOperationSchema,
            annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, ...(readOnly ? { idempotentHint: true } : {}) },
        },
        wrapToolHandler('executeApiOperation', async (args) => toToolResult(await client.executeApiOperation(args, { readOnly })))
    );
}
