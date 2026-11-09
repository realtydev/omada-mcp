import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { EnvironmentConfig } from '../config.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { logger } from '../utils/logger.js';
import { createServer } from './common.js';

interface StreamTransportState {
    transport: StreamableHTTPServerTransport;
    server: ReturnType<typeof createServer>;
}

// Export the type for use in http.ts
export type { StreamTransportState };

/**
 * Creates a Streamable HTTP transport
 * This implements the MCP protocol version 2025-03-26
 */
export function createStreamTransport(client: OmadaClient, config: EnvironmentConfig): StreamTransportState {
    const mcpServer = createServer(client, config);

    const enableStatefulSessions = config.stateful;
    const sessionIdGenerator = enableStatefulSessions ? () => randomUUID() : undefined;

    if (!enableStatefulSessions) {
        logger.info('Starting Streamable HTTP transport in stateless mode; Mcp-Session-Id headers are optional');
    }

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator,
        allowedOrigins: config.httpAllowedOrigins,
        enableDnsRebindingProtection: true,
        onsessioninitialized: (sessionId: string) => {
            logger.info('Session initialized', { sessionId });
        },
        onsessionclosed: (sessionId: string) => {
            logger.info('Session closed', { sessionId });
        },
    });

    transport.onerror = (error: Error) => {
        logger.error('Streamable HTTP transport error', {
            error,
            message: error.message,
        });
    };

    return { transport, server: mcpServer };
}

/**
 * Handles incoming Streamable HTTP requests (GET, POST, DELETE)
 * For stateful mode, transports should be stored and reused by the caller
 */
export async function handleStreamRequest(
    client: OmadaClient,
    config: EnvironmentConfig,
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
    existingTransport?: StreamTransportState
): Promise<StreamTransportState | void> {
    // A browser visit or ordinary HTTP health probe cannot open the MCP event stream.
    // Reject it before allocating an MCP server so the SDK does not report this
    // expected protocol mismatch as a transport failure.
    if (req.method === 'GET' && !req.headers.accept?.includes('text/event-stream')) {
        let path = '(invalid path)';
        try {
            path = new URL(req.url ?? '/', 'http://localhost').pathname;
        } catch {
            /* Do not reflect malformed request targets or query values into logs. */
        }
        logger.warn('Streamable HTTP request rejected', { reason: 'missing_event_stream_accept', method: 'GET', path });
        res.writeHead(406, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Not Acceptable: Client must accept text/event-stream' },
                id: null,
            })
        );
        return;
    }

    const originHeader = req.headers.origin;
    const hostHeader = req.headers.host;

    logger.info('Streamable HTTP request received', {
        method: req.method,
        url: req.url,
        sessionId: req.headers['mcp-session-id'] ?? undefined,
        origin: originHeader ?? '(not set)',
        host: hostHeader ?? '(not set)',
    });

    // Reuse existing transport if provided, otherwise create new one
    const state = existingTransport ?? createStreamTransport(client, config);

    let closing = false;
    const closeCreatedState = async () => {
        if (existingTransport || closing) {
            return;
        }
        closing = true;
        const results = await Promise.allSettled([state.server.close(), state.transport.close()]);
        for (const result of results) {
            if (result.status === 'rejected') {
                logger.error('Error closing Streamable HTTP request', { error: result.reason });
            }
        }
    };

    try {
        if (!existingTransport) {
            // Stateless responses may stream after handleRequest resolves. Keep the MCP server
            // alive until that response finishes or disconnects, then release its resources.
            if (!config.stateful) {
                res.once('finish', () => {
                    void closeCreatedState();
                });
                res.once('close', () => {
                    void closeCreatedState();
                });
            }
            await state.server.connect(state.transport);
        }
        await state.transport.handleRequest(req, res, parsedBody);

        logger.debug('Streamable HTTP request handled', {
            method: req.method,
            sessionId: req.headers['mcp-session-id'] ?? undefined,
        });
    } catch (error) {
        await closeCreatedState();
        logger.error('Failed to handle Streamable HTTP request', {
            error,
            method: req.method,
            url: req.url,
            origin: originHeader ?? '(not set)',
            host: hostHeader ?? '(not set)',
            allowedOrigins: config.httpAllowedOrigins,
        });
        throw error;
    }

    // Return state for session management if stateful
    if (config.stateful) {
        if (!existingTransport && !state.transport.sessionId) {
            await closeCreatedState();
            return;
        }
        return state;
    }
}
