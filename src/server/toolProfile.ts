import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import type { ToolProfile } from '../config.js';

/** Apply exposure policy only while registering tools; the returned MCP server remains untouched. */
export function toolRegistrationServer(server: McpServer, profile: ToolProfile): McpServer {
    if (profile === 'full') {
        return server;
    }

    return new Proxy(server, {
        get(target, property) {
            if (property === 'registerTool') {
                return <OutputArgs extends ZodRawShapeCompat | AnySchema, InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
                    name: string,
                    config: {
                        title?: string;
                        description?: string;
                        inputSchema?: InputArgs;
                        outputSchema?: OutputArgs;
                        annotations?: ToolAnnotations;
                        _meta?: Record<string, unknown>;
                    },
                    handler: ToolCallback<InputArgs>
                ) => {
                    // Unknown naming families fail closed, even when they claim to be read-only.
                    if (!/^(get|list|search|diagnose)[A-Z]/.test(name) || config.annotations?.destructiveHint === true) {
                        return undefined;
                    }
                    return target.registerTool<OutputArgs, InputArgs>(
                        name,
                        { ...config, annotations: { ...config.annotations, readOnlyHint: true, destructiveHint: false } },
                        handler
                    );
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
