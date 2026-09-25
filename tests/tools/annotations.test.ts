import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import type { OmadaClient } from '../../src/omadaClient/index.js';
import { registerAllTools } from '../../src/tools/index.js';

// Tools that change controller or device state, by naming convention.
const MUTATING = /^(create|update|delete|set|batch|start|reboot|adopt|block|unblock|reconnect)/;

describe('tool annotations', () => {
    it('marks every state-changing tool as destructive so clients can confirm before running it', () => {
        const registered: Array<{ name: string; config: { annotations?: { destructiveHint?: boolean } } }> = [];
        const server = {
            registerTool: vi.fn((name, config) => registered.push({ name, config })),
        } as unknown as McpServer;

        registerAllTools(server, {} as OmadaClient);

        const mutating = registered.filter(({ name }) => MUTATING.test(name));
        expect(mutating.length).toBeGreaterThan(30);

        const unmarked = mutating.filter(({ config }) => config.annotations?.destructiveHint !== true).map(({ name }) => name);
        expect(unmarked).toEqual([]);
    });
});
