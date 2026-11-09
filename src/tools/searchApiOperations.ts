import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const searchApiOperationsSchema = z
    .object({
        query: z.string().trim().min(1).max(256).optional().describe('Keywords such as "wireless interference" or "VPN peers"'),
        tag: z.string().trim().min(1).max(128).optional().describe('Restrict results to an API category'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum matching operations, from 1 to 50'),
    })
    .strict();

export function registerSearchApiOperationsTool(server: McpServer, client: OmadaClient, options: { readOnly?: boolean } = {}): void {
    const readOnly = options.readOnly === true;
    server.registerTool(
        'searchApiOperations',
        {
            description:
                'Search the controller-aware Open API catalogue by keywords, category or method. With no filters, browse a bounded first page. ' +
                'Results identify the live or bundled source. Describe an operation before executing it; discovery does not prove device support.',
            inputSchema: searchApiOperationsSchema,
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        },
        wrapToolHandler('searchApiOperations', async (args) => toToolResult(await client.searchApiOperations(args, { readOnly })))
    );
}
