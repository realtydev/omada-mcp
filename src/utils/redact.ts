/** Redact values in tool/request logs; returned tool data is unaffected. */
export function redactForLogs(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (depth > 20) return '[depth limit]';
    if (typeof value === 'string') {
        if (/-----BEGIN (?:\w+ )?PRIVATE KEY-----/.test(value)) return '[redacted]';
        if (/^[\s]*[[{]/.test(value)) {
            try {
                return JSON.stringify(redactForLogs(JSON.parse(value), depth + 1, seen));
            } catch {
                /* Ordinary text. */
            }
        }
        return value;
    }
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    try {
        if (Array.isArray(value)) return value.map((item) => redactForLogs(item, depth + 1, seen));
        const output: Record<string, unknown> = Object.create(null);
        for (const [key, item] of Object.entries(value)) {
            output[key] = /password|passwd|secret|token|cookie|authorization|psk|private.?key|api.?key|credential|client.?id/i.test(key)
                ? '[redacted]'
                : redactForLogs(item, depth + 1, seen);
        }
        return output;
    } finally {
        seen.delete(value);
    }
}
