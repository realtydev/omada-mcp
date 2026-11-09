import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OmadaClient } from '../omadaClient/index.js';
import { rateLimitProfileUpdateSchema } from '../omadaClient/rateLimitProfile.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

export function registerUpdateRateLimitProfileTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'updateRateLimitProfile',
        {
            description:
                'Update a rate-limit profile while preserving other writable settings. Defaults to a preview; set dryRun:false to write once and verify read-back. A verified change returns a caller-held rollback receipt. Profiles assigned to clients affect their traffic limits.',
            inputSchema: z
                .object({
                    profileId: z.string().min(1),
                    siteId: z.string().min(1).optional(),
                    settings: rateLimitProfileUpdateSchema,
                    dryRun: z.boolean().optional().default(true),
                })
                .strict(),
            annotations: { destructiveHint: true },
        },
        wrapToolHandler('updateRateLimitProfile', async ({ profileId, siteId, settings, dryRun }) =>
            toToolResult(await client.updateRateLimitProfile(profileId, settings, siteId, dryRun))
        )
    );
}
