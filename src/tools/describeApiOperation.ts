import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const describeApiOperationSchema = z
    .object({ operationId: z.string().trim().min(1).max(256).describe('An operationId returned by searchApiOperations') })
    .strict();

export function registerDescribeApiOperationTool(server: McpServer, client: OmadaClient, options: { readOnly?: boolean } = {}): void {
    const readOnly = options.readOnly === true;
    server.registerTool(
        'describeApiOperation',
        {
            description:
                'Describe one discovered Open API operation: method, path, parameters, request/response schemas, and controller documentation. ' +
                'Includes specification source and schema-resolution limits. Dedicated tools retain their specialized previews and verification.',
            inputSchema: describeApiOperationSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('describeApiOperation', async ({ operationId }) => toToolResult(await client.describeApiOperation(operationId, { readOnly })))
    );
}
