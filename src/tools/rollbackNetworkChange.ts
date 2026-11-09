import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { networkChangeReceiptSchema } from '../omadaClient/networkChange.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerRollbackNetworkChangeTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'rollbackNetworkChange',
        {
            description:
                'Preview or restore a verified rate-limit profile, DHCP reservation, AP radio or secret-free SSID basic change using its caller-held receipt. Refuses rollback when current settings drifted from the applied snapshot, and verifies restored settings after one write. Receipts are validated configuration data, not authorization tokens. SSID rollback supports complete open/enterprise basic configurations only; password-bearing changes never issue a receipt.',
            inputSchema: z.object({ receipt: networkChangeReceiptSchema, dryRun: z.boolean().optional().default(true) }).strict(),
            annotations: { destructiveHint: true },
        },
        wrapToolHandler('rollbackNetworkChange', async ({ receipt, dryRun }) => toToolResult(await client.rollbackNetworkChange(receipt, dryRun)))
    );
}
