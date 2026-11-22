import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { MspCustomerScope } from '../omadaClient/mspCustomers.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const emptySchema = z.object({});

/** Registered only on MSP controllers (OMADA_MSP_ID set). */
export function registerListMspCustomersTool(server: McpServer, scope: MspCustomerScope): void {
    server.registerTool(
        'listMspCustomers',
        {
            description:
                'List the MSP customers this server may act on, with their IDs and names. Pass a returned customerId (or the exact name) as customerId to any other tool; then call listSites with that customerId to find its sites.',
            inputSchema: emptySchema.shape,
            annotations: { readOnlyHint: true },
        },
        wrapToolHandler('listMspCustomers', async () => toToolResult(await scope.listCustomers()))
    );
}
