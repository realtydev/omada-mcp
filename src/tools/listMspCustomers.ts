import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const emptySchema = z.object({});

/** Registered only on MSP controllers (OMADA_MSP_ID set). */
export function registerListMspCustomersTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'listMspCustomers',
        {
            description:
                'List permitted MSP customers with their IDs and names. Pass an ID or exact name as customerId to customer-scoped tools. Use listSites to find a customer’s sites.',
            inputSchema: emptySchema.shape,
            annotations: { readOnlyHint: true },
        },
        wrapToolHandler('listMspCustomers', async () => toToolResult(await client.listMspCustomers()))
    );
}
