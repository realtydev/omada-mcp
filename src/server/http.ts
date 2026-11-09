import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import ngrok from '@ngrok/ngrok';
import type { EnvironmentConfig } from '../config.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { normalizePath, resolvePort } from '../utils/config-validations.js';
import { logger } from '../utils/logger.js';
import { SessionRegistry } from './sessionRegistry.js';
import { createSseTransport, getSseMessagePath, handleSseConnection, handleSseMessage } from './sse.js';
import { handleStreamRequest, type StreamTransportState } from './stream.js';

const DEFAULT_PORT = 3000;
const HEALTH_PATH = '/healthz';

type ShutdownHandler = () => Promise<void>;

function getRequestUrl(req: IncomingMessage, fallbackPort: number): URL | undefined {
    if (!req.url) {
        return undefined;
    }

    const host = req.headers.host ?? `localhost:${fallbackPort}`;
    try {
        return new URL(req.url, `http://${host}`);
    } catch {
        return undefined;
    }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

function sanitizeHeaders(headers: IncomingHttpHeaders): Record<string, unknown> {
    const sanitized: Record<string, unknown> = Object.create(null);

    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) {
            continue;
        }

        if (Array.isArray(value)) {
            sanitized[key] = value.map((entry) => sanitizeHeaderValue(key, entry));
        } else {
            sanitized[key] = sanitizeHeaderValue(key, value);
        }
    }

    return sanitized;
}

function sanitizeHeaderValue(key: string, value: string): string {
    const sanitized = isSensitiveKey(key) ? maskValue(value) : value;
    return typeof sanitized === 'string' ? sanitized : String(sanitized);
}

function sanitizePayload(payload: unknown): unknown {
    if (payload === null || payload === undefined) {
        return payload;
    }

    if (typeof payload === 'string') {
        return isLikelySensitiveString(payload) ? maskValue(payload) : payload;
    }

    if (Array.isArray(payload)) {
        return payload.map((entry) => sanitizePayload(entry));
    }

    if (typeof payload === 'object') {
        const sanitized: Record<string, unknown> = Object.create(null);
        for (const [key, value] of Object.entries(payload)) {
            sanitized[key] = isSensitiveKey(key) ? maskValue(value) : sanitizePayload(value);
        }
        return sanitized;
    }

    return payload;
}

function isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return (
        normalized.includes('authorization') ||
        normalized.includes('token') ||
        normalized.includes('secret') ||
        normalized.includes('password') ||
        normalized.includes('cookie') ||
        normalized.includes('client-id')
    );
}

function isLikelySensitiveString(value: string): boolean {
    return value.length > 16 && /[A-Za-z0-9+/=]{16,}/.test(value);
}

function maskValue(value: unknown): unknown {
    if (typeof value === 'string') {
        if (value.length <= 8) {
            return '********';
        }
        return `${value.slice(0, 4)}…${value.slice(-4)}`;
    }

    if (Array.isArray(value)) {
        return value.map(() => '********');
    }

    if (typeof value === 'object' && value !== null) {
        return '[masked-object]';
    }

    return '********';
}

async function createShutdownHandler(signal: NodeJS.Signals, closeHttp: () => Promise<void>, closeSessions: () => Promise<void>): Promise<void> {
    logger.warn('Received shutdown signal', { signal });

    try {
        await closeSessions();
    } catch (error) {
        logger.error('Error closing MCP sessions', { error });
    }

    try {
        await closeHttp();
    } catch (error) {
        logger.error('Error closing HTTP server', { error });
    }
}

/**
 * Starts the HTTP server with the configured transport (SSE or Stream)
 */
export async function startHttpServer(client: OmadaClient, config: EnvironmentConfig): Promise<void> {
    const transport = config.httpTransport;
    logger.info('Starting HTTP server', { transport });

    const port = resolvePort(config.httpPort, DEFAULT_PORT);
    const host = config.httpBindAddr ?? '127.0.0.1';
    const endpointPath = normalizePath(config.httpPath ?? (transport === 'sse' ? '/sse' : '/mcp'));

    // Track transports by session ID for stateful mode
    const maxSessions = config.httpMaxSessions ?? 100;
    const idleTimeoutMs = config.httpSessionIdleTimeoutMs ?? 1_800_000;
    const sseTransports = new SessionRegistry<{ transport: SSEServerTransport; server: ReturnType<typeof createSseTransport>['server'] }>(
        maxSessions,
        idleTimeoutMs
    );
    const streamTransports = new SessionRegistry<StreamTransportState>(maxSessions, idleTimeoutMs);
    const rejectCapacity = (res: ServerResponse) => {
        res.setHeader('Retry-After', '60');
        sendJson(res, 503, { error: 'MCP session capacity reached. Retry later or close an existing session.' });
    };

    const httpServer = http.createServer((req, res) => {
        void (async () => {
            const url = getRequestUrl(req, port);
            if (!url) {
                logger.warn('HTTP request rejected', {
                    reason: 'invalid-url',
                    method: req.method,
                    url: req.url,
                });
                sendJson(res, 400, { error: 'Invalid request URL.' });
                return;
            }

            logger.debug('HTTP request headers', {
                method: req.method,
                path: url.pathname,
                headers: sanitizeHeaders(req.headers),
            });

            const bodyChunks: Buffer[] = [];
            const shouldCaptureBody = (req.method ?? 'GET').toUpperCase() !== 'GET';
            if (shouldCaptureBody) {
                req.on('data', (chunk) => {
                    const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
                    bodyChunks.push(bufferChunk);
                });

                await new Promise<void>((resolve) => {
                    req.on('end', () => resolve());
                });
            }

            logger.info('HTTP request received', {
                method: req.method,
                path: url.pathname,
                query: url.search,
                sessionId: req.headers['mcp-session-id'] ?? undefined,
            });

            // Health check endpoint
            if (config.httpEnableHealthcheck && url.pathname === (config.httpHealthcheckPath ?? HEALTH_PATH)) {
                logger.debug('Health check request served');
                sendJson(res, 200, { status: 'ok' });
                return;
            }

            let parsedBody: unknown = null;
            if (shouldCaptureBody && bodyChunks.length > 0) {
                const rawBody = Buffer.concat(bodyChunks).toString('utf8');
                if (rawBody.length > 0) {
                    try {
                        parsedBody = JSON.parse(rawBody);
                    } catch {
                        parsedBody = rawBody;
                    }

                    logger.debug('HTTP request body', {
                        method: req.method,
                        path: url.pathname,
                        length: rawBody.length,
                        body: sanitizePayload(parsedBody),
                    });
                }
            }

            try {
                if (transport === 'sse') {
                    // SSE Transport handling
                    if (url.pathname === endpointPath) {
                        if (req.method === 'GET') {
                            await sseTransports.expireIdle();
                            const release = sseTransports.reserve();
                            if (!release) {
                                rejectCapacity(res);
                                return;
                            }
                            try {
                                const messagePath = getSseMessagePath();
                                const state = await handleSseConnection(client, config, messagePath, req, res);
                                sseTransports.add(state.transport.sessionId, state);
                            } finally {
                                release();
                            }
                        } else {
                            sendJson(res, 405, { error: 'Method Not Allowed' });
                        }
                    } else if (url.pathname === getSseMessagePath()) {
                        if (req.method === 'POST') {
                            // Handle SSE message
                            const headerId = req.headers['mcp-session-id'];
                            const queryId = url.searchParams.get('sessionId');
                            if (Array.isArray(headerId) || (headerId && queryId && headerId !== queryId)) {
                                sendJson(res, 400, { error: 'Conflicting or invalid session IDs' });
                                return;
                            }
                            const sessionId = headerId ?? queryId;
                            if (!sessionId) {
                                sendJson(res, 400, { error: 'Missing sessionId query parameter or Mcp-Session-Id header' });
                                return;
                            }

                            const session = sseTransports.get(sessionId);
                            if (!session) {
                                sendJson(res, 404, { error: 'Session not found' });
                                return;
                            }

                            await sseTransports.handle(sessionId, () => handleSseMessage(session.transport, req, res, parsedBody));
                        } else {
                            sendJson(res, 405, { error: 'Method Not Allowed' });
                        }
                    } else {
                        sendJson(res, 404, { error: 'Not Found' });
                    }
                } else {
                    // Streamable HTTP Transport handling
                    if (url.pathname === endpointPath) {
                        const sessionId = req.headers['mcp-session-id'];
                        if (Array.isArray(sessionId)) {
                            sendJson(res, 400, { error: 'Invalid Mcp-Session-Id header' });
                            return;
                        }
                        let existingState: StreamTransportState | undefined;
                        if (config.stateful && sessionId) {
                            existingState = streamTransports.get(sessionId);
                            if (!existingState) {
                                sendJson(res, 404, { error: 'Session not found' });
                                return;
                            }
                        }
                        if (existingState && sessionId) {
                            if (req.method === 'GET') {
                                // A persistent event stream is not an in-flight tool operation.
                                await handleStreamRequest(client, config, req, res, parsedBody, existingState);
                            } else {
                                await streamTransports.handle(sessionId, () =>
                                    handleStreamRequest(client, config, req, res, parsedBody, existingState)
                                );
                            }
                        } else {
                            if (config.stateful) {
                                await streamTransports.expireIdle();
                            }
                            const release = config.stateful ? streamTransports.reserve() : () => undefined;
                            if (!release) {
                                rejectCapacity(res);
                                return;
                            }
                            try {
                                const state = await handleStreamRequest(client, config, req, res, parsedBody);
                                if (config.stateful && state?.transport.sessionId) {
                                    streamTransports.add(state.transport.sessionId, state);
                                }
                            } finally {
                                release();
                            }
                        }
                    } else {
                        sendJson(res, 404, { error: 'Not Found' });
                    }
                }

                logger.info('MCP request handled successfully', {
                    path: url.pathname,
                    method: req.method,
                });
            } catch (error) {
                logger.error('Failed to handle MCP HTTP request', { error });
                if (!res.headersSent) {
                    sendJson(res, 500, {
                        jsonrpc: '2.0',
                        error: { code: -32000, message: 'Internal server error' },
                        id: null,
                    });
                } else {
                    res.end();
                }
            }
        })();
    });

    httpServer.on('clientError', (error, socket) => {
        logger.error('HTTP client error', { error });
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    await new Promise<void>((resolve) => {
        httpServer.listen(port, host, () => {
            const displayHost = host === '0.0.0.0' ? 'localhost' : host;
            logger.info('HTTP server listening', {
                endpoint: `http://${displayHost}:${port}${endpointPath}`,
                transport,
            });
            if (config.httpEnableHealthcheck) {
                logger.info('HTTP health check available', {
                    endpoint: `http://${displayHost}:${port}${config.httpHealthcheckPath ?? HEALTH_PATH}`,
                });
            }
            logger.info('HTTP server ready');
            resolve();
        });
    });

    // Start ngrok tunnel if configured
    if (config.httpNgrokEnabled) {
        if (!config.httpNgrokAuthToken) {
            logger.warn('Ngrok enabled but no auth token provided; skipping tunnel setup');
        } else {
            try {
                const listener = await ngrok.forward({
                    addr: port,
                    authtoken: config.httpNgrokAuthToken,
                });
                const url = listener.url();
                logger.info('Ngrok tunnel established', { url });
            } catch (error) {
                logger.error('Failed to start ngrok tunnel', {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    let shuttingDown: boolean = false;
    const closeHttp: ShutdownHandler = () =>
        new Promise((resolve) => {
            httpServer.close(() => resolve());
        });
    const closeSessions: ShutdownHandler = async () => {
        await Promise.all([sseTransports.close(), streamTransports.close()]);
    };

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            if (!shuttingDown) {
                shuttingDown = true;
                void createShutdownHandler(signal, closeHttp, closeSessions);
            }
        });
    }
}

export {
    createShutdownHandler,
    getRequestUrl,
    isLikelySensitiveString,
    isSensitiveKey,
    maskValue,
    sanitizeHeaders,
    sanitizeHeaderValue,
    sanitizePayload,
    sendJson,
};
