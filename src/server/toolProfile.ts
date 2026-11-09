import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import type { ToolProfile } from '../config.js';
import { ToolAccessPolicy } from './toolPolicy.js';

/** Apply exposure policy only while registering tools; the returned MCP server remains untouched. */
export function toolRegistrationServer(server: McpServer, profile: ToolProfile, policy = new ToolAccessPolicy(profile)): McpServer {
    if (policy.unrestricted) {
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
                    const discoveryRead = ['describeApiOperation', 'executeApiOperation'].includes(name) && config.annotations?.readOnlyHint === true;
                    if (
                        policy.readOnly &&
                        ((!/^(get|list|search|diagnose)[A-Z]/.test(name) && !discoveryRead) || config.annotations?.destructiveHint === true)
                    ) {
                        return undefined;
                    }
                    if (!policy.allowsTool(name, config.annotations?.destructiveHint === true)) return undefined;
                    return target.registerTool<OutputArgs, InputArgs>(
                        name,
                        policy.readOnly || !policy.permitsWrites
                            ? { ...config, annotations: { ...config.annotations, readOnlyHint: true, destructiveHint: false } }
                            : config,
                        (async (args: unknown, extra: unknown) => {
                            policy.assertTool(name, args, config.annotations?.destructiveHint === true);
                            if (name === 'genericApiCall') {
                                const request = args as { method: string; path: string; version?: string; queryParams?: Record<string, unknown> };
                                policy.assertGeneric(request.method, request.path, request.version ?? 'v1', request.queryParams);
                            }
                            return await Reflect.apply(handler, undefined, [args, extra]);
                        }) as ToolCallback<InputArgs>
                    );
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
