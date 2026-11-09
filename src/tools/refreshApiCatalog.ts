import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerRefreshApiCatalogTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'refreshApiCatalog',
        {
            description:
                'Reload the configured controller API catalogue and report bounded, sanitized discovery diagnostics. ' +
                'Performs documentation reads only; no caller-supplied URLs or controller mutations. Existing operations keep their original snapshot, ' +
                'concurrent refreshes share one load, and a failed live-only refresh retains the previous catalogue.',
            inputSchema: z.object({}).strict(),
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
        },
        wrapToolHandler('refreshApiCatalog', async () => toToolResult(await client.refreshApiCatalog()))
    );
}
