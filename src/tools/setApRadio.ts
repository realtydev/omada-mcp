import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const setApRadioSchema = z.object({
    siteId: z.string().min(1).optional(),
    apMac: z.string().min(1, 'apMac is required').describe('AP MAC address, like AA-BB-CC-DD-EE-FF'),
    band: z.enum(['2g', '5g', '5g2', '6g']).describe('Radio band to change: 2g, 5g (single 5 GHz radio, or 5GHz-1), 5g2 (second 5 GHz radio) or 6g'),
    radioEnable: z.boolean().optional().describe('Enable or disable this radio'),
    channel: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
            "Channel INDEX, not the channel number: 0 = auto, otherwise the index from the AP's available channels (e.g. index 1 is channel 36 on a 5 GHz radio). Unavailable indexes are rejected with the valid list"
        ),
    channelWidth: z
        .number()
        .int()
        .min(2)
        .max(10)
        .optional()
        .describe('Channel width code: 2=20MHz, 3=40MHz, 4=2.4G auto, 5=80MHz, 6=5G auto, 7=160MHz, 8=160/80/40/20, 9=240MHz, 10=320MHz'),
    txPowerLevel: z.number().int().min(0).max(4).optional().describe('Tx power level: 0=low, 1=medium, 2=high, 3=custom, 4=auto'),
    txPower: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Tx power in dBm; applies with txPowerLevel 3 (custom), which is set implicitly when txPowerLevel is omitted'),
    dryRun: z.boolean().optional().default(false).describe('Return the diff and the exact PATCH body without writing anything (default: false)'),
});

export function registerSetApRadioTool(server: McpServer, client: OmadaClient): void {
    server.registerTool(
        'setApRadio',
        {
            description:
                'Change one radio band of an AP: enable/disable, channel index, channel width, tx power. Changes live wireless configuration and ' +
                'can drop every client on that band while the radio reconfigures. It reads the current band, sends the complete band with your ' +
                'changes applied, re-reads it, and returns a before/after diff; if the controller answers success but a requested value did not ' +
                'take (e.g. a tx power outside what the AP or region allows) it fails with the value the controller kept. Use dryRun to preview.',
            inputSchema: setApRadioSchema.strict(),
            annotations: {
                destructiveHint: true,
            },
        },
        wrapToolHandler('setApRadio', async ({ apMac, band, siteId, dryRun, ...settings }) =>
            toToolResult(await client.setApRadio(apMac, band, settings, siteId, dryRun))
        )
    );
}
