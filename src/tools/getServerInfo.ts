import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { BUILD_TIME, GIT_COMMIT, PACKAGE_VERSION } from '../generated/buildInfo.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { toToolResult, wrapToolHandler } from '../server/common.js';

const getServerInfoSchema = z.object({}).strict();

/**
 * Registers a read-only tool that reports the actual build running in this process.
 *
 * For stdio transport, each session's MCP client spawns its own server subprocess at connection
 * time, and that process keeps running whatever code it loaded then — rebuilding `dist/` on disk
 * does not affect an already-running process, only a fresh connection does. There is otherwise no
 * signal that a session is still talking to a pre-merge build, so before relying on a recently
 * changed tool's behavior (especially anything billed as dry-run or safe-by-default), call this
 * first and compare `gitCommit` against the commit you expect to be running.
 */
export function registerGetServerInfoTool(server: McpServer, _client: OmadaClient): void {
    server.registerTool(
        'getServerInfo',
        {
            description:
                'Report the package version, git commit, and build time this MCP server process was actually built from. Call this ' +
                'after a restart/reconnect to confirm the server picked up a merged change before relying on new tool behavior — a ' +
                'stale stdio subprocess keeps running its old code even after dist/ is rebuilt on disk, until a fresh connection is made.',
            inputSchema: getServerInfoSchema,
        },
        wrapToolHandler('getServerInfo', () =>
            Promise.resolve(toToolResult({ packageVersion: PACKAGE_VERSION, gitCommit: GIT_COMMIT, buildTime: BUILD_TIME }))
        )
    );
}
