import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type AnySchema, safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PACKAGE_VERSION } from '../generated/buildInfo.js';
import { type ToolExtra, toToolResult } from './common.js';

export type ToolCatalog = Map<
    string,
    {
        description?: string;
        inputSchema: z.ZodObject;
        outputSchema?: AnySchema;
        annotations?: ToolAnnotations;
        handler: (args: Record<string, unknown>, extra: ToolExtra) => Promise<CallToolResult>;
    }
>;

/** Dispatch the same validated, policy-checked handlers that standard mode registers. */
export function registerCompactTools(server: McpServer, catalog: ToolCatalog): void {
    const read = { readOnlyHint: true, destructiveHint: false };
    const find = (name: string) => {
        const tool = catalog.get(name);
        if (!tool) throw new Error(`Tool ${name} is unavailable under this server's policy.`);
        return tool;
    };
    server.registerTool(
        'searchTools',
        {
            description:
                'Search enabled Omada tools, including diagnostics and API discovery. Inspect a match with describeTool, then invoke it with callTool.',
            inputSchema: z.object({ query: z.string().max(200).default(''), limit: z.number().int().min(1).max(50).default(10) }).strict(),
            annotations: read,
        },
        ({ query, limit }) => {
            const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
            const matches = [...catalog].filter(([name, tool]) =>
                terms.every((term) => `${name} ${tool.description ?? ''}`.toLowerCase().includes(term))
            );
            return toToolResult({
                total: matches.length,
                truncated: matches.length > limit,
                tools: matches.slice(0, limit).map(([name, tool]) => ({ name, description: tool.description, annotations: tool.annotations })),
            });
        }
    );
    server.registerTool(
        'describeTool',
        {
            description:
                'Inspect the exact argument schema of an enabled tool. API operation IDs are discovered through searchApiOperations, not tool names.',
            inputSchema: z.object({ name: z.string().min(1).max(128) }).strict(),
            annotations: read,
        },
        ({ name }) => {
            const tool = find(name);
            return toToolResult({
                name,
                description: tool.description,
                annotations: tool.annotations,
                inputSchema: toJsonSchemaCompat(tool.inputSchema, { strictUnions: true, pipeStrategy: 'input' }),
            });
        }
    );
    server.registerTool(
        'getServerCapabilities',
        {
            description: 'Report this compact catalog and its effective write exposure. Catalog availability is not evidence of hardware support.',
            inputSchema: z.object({}).strict(),
            annotations: read,
        },
        () =>
            toToolResult({
                version: PACKAGE_VERSION,
                catalogMode: 'compact',
                enabledTools: catalog.size,
                writesEnabled: [...catalog.values()].some((tool) => tool.annotations?.destructiveHint === true),
                mutationDefault: 'preview',
            })
    );
    server.registerTool(
        'callTool',
        {
            description:
                'Invoke an enabled tool by its exact name with validated arguments. Discover with searchTools and inspect with describeTool first. Existing tool policy, write previews, and verification apply.',
            inputSchema: z.object({ name: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()).default({}) }).strict(),
            annotations: {
                readOnlyHint: ![...catalog.values()].some((tool) => tool.annotations?.destructiveHint === true),
                destructiveHint: [...catalog.values()].some((tool) => tool.annotations?.destructiveHint === true),
            },
        },
        async ({ name, arguments: args }, extra) => {
            const tool = find(name);
            const parsed = await tool.inputSchema.parseAsync(args);
            const result = await tool.handler(parsed, extra);
            if (tool.outputSchema && !result.isError) {
                const output = await safeParseAsync(tool.outputSchema, result.structuredContent);
                if (!output.success) throw new Error('Tool returned invalid structured output.');
            }
            return result;
        }
    );
}
