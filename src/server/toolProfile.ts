import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { normalizeObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { ToolProfile } from '../config.js';
import { MISSING_MSP_CUSTOMER, type MspCustomerScope } from '../omadaClient/mspCustomers.js';
import { redactForLogs } from '../utils/redact.js';
import { type ToolExtra, toToolResult } from './common.js';
import type { ToolCatalog } from './toolCatalog.js';
import { ToolAccessPolicy } from './toolPolicy.js';

/** Tools that never touch customer data and therefore take no MSP customerId. */
const customerlessTools = new Set(['listMspCustomers', 'getServerInfo', 'searchApiOperations', 'describeApiOperation', 'refreshApiCatalog']);

/** Apply exposure policy only while registering tools; the returned MCP server remains untouched. */
export function toolRegistrationServer(
    server: McpServer,
    profile: ToolProfile,
    policy = new ToolAccessPolicy(profile),
    catalog?: ToolCatalog,
    customerScope?: MspCustomerScope
): McpServer {
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
                    const discoveryRead =
                        ['describeApiOperation', 'executeApiOperation', 'refreshApiCatalog'].includes(name) &&
                        config.annotations?.readOnlyHint === true;
                    if (
                        policy.readOnly &&
                        ((!/^(get|list|search|diagnose)[A-Z]/.test(name) && !discoveryRead) || config.annotations?.destructiveHint === true)
                    ) {
                        return undefined;
                    }
                    if (!policy.allowsTool(name, config.annotations?.destructiveHint === true)) return undefined;
                    // All repository tools use Zod 4 objects or raw shapes; preserve object refinements.
                    const original =
                        config.inputSchema instanceof z.ZodObject ? config.inputSchema : z.object((config.inputSchema ?? {}) as z.ZodRawShape);
                    const write = config.annotations?.destructiveHint === true && name !== 'executeApiOperation';
                    const nativePreview = Object.hasOwn(original.shape, 'dryRun');
                    const discoveryExecution = name === 'executeApiOperation';
                    const customerScoped = customerScope !== undefined && !customerlessTools.has(name);
                    const customerId = z
                        .string({ error: MISSING_MSP_CUSTOMER })
                        .trim()
                        .min(1)
                        .max(128)
                        .describe(
                            discoveryExecution
                                ? 'MSP customer ID or name for customer-scoped operations. MSP-wide operations omit this argument.'
                                : 'MSP customer ID or exact name. When omitted, use the configured default customer.'
                        );
                    const scoped = customerScoped
                        ? original.safeExtend({
                              customerId: discoveryExecution || customerScope.defaultCustomerId ? customerId.optional() : customerId,
                          })
                        : original;
                    const inputSchema = write
                        ? scoped
                              .safeExtend({ dryRun: z.boolean().default(true).describe('Preview by default; set false explicitly to apply.') })
                              .strict()
                        : scoped;
                    const definition = {
                        ...config,
                        inputSchema,
                        ...(write
                            ? { description: `${config.description ?? name} Writes preview by default; set dryRun:false explicitly to apply.` }
                            : {}),
                        ...(policy.readOnly || !policy.permitsWrites
                            ? { annotations: { ...config.annotations, readOnlyHint: true, destructiveHint: false } }
                            : {}),
                    };
                    const invoke = async (args: Record<string, unknown>, extra: ToolExtra) => {
                        policy.assertTool(name, args, config.annotations?.destructiveHint === true);
                        if (name === 'genericApiCall') {
                            const request = args as { method: string; path: string; version?: string; queryParams?: Record<string, unknown> };
                            policy.assertGeneric(request.method, request.path, request.version ?? 'v1', request.queryParams);
                        }
                        const mutation = write && (name !== 'genericApiCall' || args.method !== 'GET');
                        if (mutation && !nativePreview && args.dryRun !== false) {
                            return toToolResult({
                                dryRun: true,
                                written: false,
                                verified: false,
                                tool: name,
                                arguments: redactForLogs(args),
                                warning:
                                    'Schema-only preview. No controller request or preflight was performed; controller acceptance and device support are unverified.',
                            });
                        }
                        const forwarded = { ...args };
                        if (write && !nativePreview) delete forwarded.dryRun;
                        const invokeHandler = async () => await Reflect.apply(handler, undefined, [forwarded, extra]);
                        if (!customerScoped || discoveryExecution) return await invokeHandler();
                        delete forwarded.customerId;
                        return await customerScope.run(
                            typeof args.customerId === 'string' ? args.customerId : undefined,
                            invokeHandler,
                            Object.hasOwn(original.shape, 'siteId') && !args.siteId
                        );
                    };
                    if (catalog) {
                        catalog.set(name, {
                            ...definition,
                            outputSchema: config.outputSchema ? normalizeObjectSchema(config.outputSchema) : undefined,
                            handler: invoke,
                        });
                        return undefined;
                    }
                    return target.registerTool(name, definition, invoke);
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
