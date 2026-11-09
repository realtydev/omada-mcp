import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { logger } from '../utils/logger.js';

interface SessionState {
    transport: Pick<Transport, 'close' | 'onclose' | 'onmessage' | 'send'>;
    server: { close(): Promise<void> };
}

interface SessionEntry<T> {
    state: T;
    lastActivity: number;
    activeRequests: Set<string>;
    activeHandlers: number;
    closing?: Promise<void>;
}

/** Bounds retained sessions, including connections that are still being initialized. */
export class SessionRegistry<T extends SessionState> {
    private readonly sessions = new Map<string, SessionEntry<T>>();
    private pending = 0;
    private stopped: boolean = false;
    private readonly timer: ReturnType<typeof setInterval>;

    constructor(
        private readonly maxSessions: number,
        private readonly idleTimeoutMs: number
    ) {
        this.timer = setInterval(
            () => {
                void this.expireIdle();
            },
            Math.min(idleTimeoutMs, 60_000)
        );
        this.timer.unref();
    }

    /** Reserve synchronously before awaiting connection creation. Release in a finally block. */
    public reserve(): (() => void) | undefined {
        if (this.stopped || this.sessions.size + this.pending >= this.maxSessions) {
            return undefined;
        }
        this.pending += 1;
        let released = false;
        return () => {
            if (!released) {
                released = true;
                this.pending -= 1;
            }
        };
    }

    public add(sessionId: string, state: T): void {
        if (this.stopped) {
            void this.closeState(state);
            return;
        }
        const entry: SessionEntry<T> = { state, lastActivity: Date.now(), activeRequests: new Set(), activeHandlers: 0 };
        this.sessions.set(sessionId, entry);

        // Protocol handlers own onclose; preserve them so pending requests are rejected on expiry.
        const onclose = state.transport.onclose;
        state.transport.onclose = () => {
            try {
                onclose?.();
            } finally {
                void this.closeEntry(sessionId, entry);
            }
        };

        // SSE POST acknowledgements precede tool completion. Track JSON-RPC requests until their
        // actual response is sent, rather than treating an HTTP 202 as completed work.
        const onmessage = state.transport.onmessage;
        state.transport.onmessage = (message, extra) => {
            entry.lastActivity = Date.now();
            if ('method' in message && 'id' in message) {
                entry.activeRequests.add(JSON.stringify(message.id));
            }
            onmessage?.(message, extra);
        };
        const send = state.transport.send?.bind(state.transport);
        if (send) {
            state.transport.send = async (message, options) => {
                try {
                    await send(message, options);
                } finally {
                    if (!('method' in message) && 'id' in message) {
                        entry.activeRequests.delete(JSON.stringify(message.id));
                        entry.lastActivity = Date.now();
                    }
                }
            };
        }
    }

    public get(sessionId: string): T | undefined {
        const entry = this.sessions.get(sessionId);
        if (!entry || entry.closing !== undefined) {
            return undefined;
        }
        if (this.isIdle(entry)) {
            void this.closeEntry(sessionId, entry);
            return undefined;
        }
        entry.lastActivity = Date.now();
        return entry.state;
    }

    public async handle<R>(sessionId: string, operation: () => Promise<R>): Promise<R> {
        const entry = this.sessions.get(sessionId);
        if (entry) {
            entry.lastActivity = Date.now();
            entry.activeHandlers += 1;
        }
        try {
            return await operation();
        } finally {
            if (entry) {
                entry.activeHandlers -= 1;
                entry.lastActivity = Date.now();
            }
        }
    }

    public async expireIdle(): Promise<void> {
        await Promise.all([...this.sessions].filter(([, entry]) => this.isIdle(entry)).map(([id, entry]) => this.closeEntry(id, entry)));
    }

    public async close(): Promise<void> {
        this.stopped = true;
        clearInterval(this.timer);
        await Promise.all([...this.sessions].map(([id, entry]) => this.closeEntry(id, entry)));
    }

    private isIdle(entry: SessionEntry<T>): boolean {
        return (
            entry.closing === undefined &&
            entry.activeHandlers === 0 &&
            entry.activeRequests.size === 0 &&
            Date.now() - entry.lastActivity >= this.idleTimeoutMs
        );
    }

    private closeEntry(sessionId: string, entry: SessionEntry<T>): Promise<void> {
        if (entry.closing === undefined) {
            // Defer close until after assigning closing: transport.close can synchronously call onclose.
            entry.closing = Promise.resolve()
                .then(() => this.closeState(entry.state))
                .finally(() => {
                    if (this.sessions.get(sessionId) === entry) {
                        this.sessions.delete(sessionId);
                    }
                });
        }
        return entry.closing;
    }

    private async closeState(state: T): Promise<void> {
        const results = await Promise.allSettled([state.server.close(), state.transport.close()]);
        for (const result of results) {
            if (result.status === 'rejected') {
                logger.error('Error closing MCP session', { error: result.reason });
            }
        }
    }
}
