import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const notificationChangeSchema = z.object({
    key: z.string().min(1).describe('Log notification key as returned by the site log-notification GET, e.g. W_C_ROAM'),
    enable: z.boolean().describe('Whether this alert/event type is logged and shown'),
    email: z.boolean().optional().describe('Whether it is also emailed (default: keep current value)'),
    webhook: z.boolean().optional().describe('Whether it is also sent to the webhook, Pro controllers only (default: keep current value)'),
});

const setLogNotificationsSchema = z.object({
    siteId: z.string().min(1).optional(),
    events: z
        .array(notificationChangeSchema)
        .optional()
        .describe("Changes to entries in the site's event notification list, e.g. W_C_ROAM, DEV_CONN"),
    alerts: z
        .array(notificationChangeSchema)
        .optional()
        .describe("Changes to entries in the site's alert notification list, e.g. DEV_DISCONN, AP_CPU_EX"),
    dryRun: z.boolean().optional().default(false).describe('Return the diff without writing anything (default: false)'),
});

export function registerSetLogNotificationsTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setLogNotifications',
        {
            description:
                'Turn individual alert/event log notification types on or off for a site (v2 log-notification). Changes live controller ' +
                'configuration: it reads the current state, applies only the named keys, writes the full state back, re-reads it and reports ' +
                'a before/after diff with a check that nothing else changed. Unknown keys are rejected before anything is sent. ' +
                'Use dryRun first to preview the diff.',
            inputSchema: setLogNotificationsSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('setLogNotifications', async ({ siteId, events, alerts, dryRun }) =>
            toToolResult(await client.setLogNotifications({ siteId, events, alerts, dryRun }))
        )
    );
}
