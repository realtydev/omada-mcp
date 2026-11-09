const SENSITIVE_KEY = /password|passwd|secret|token|cookie|authorization|psk|security.?key|private.?key|api.?key|credential|client.?id/i;

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
            output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactForLogs(item, depth + 1, seen);
        }
        return output;
    } finally {
        seen.delete(value);
    }
}

/** Controller errors may echo submitted secrets under ordinary keys such as msg. */
export function createRequestRedactor(...inputs: unknown[]): (value: unknown) => unknown {
    const secrets = new Set<string>();
    const seen = new WeakSet<object>();
    const remember = (value: string): void => {
        if (!value) return;
        secrets.add(value);
        secrets.add(JSON.stringify(value).slice(1, -1));
        try {
            secrets.add(encodeURIComponent(value));
        } catch {
            /* Invalid surrogate pairs still have their literal form. */
        }
    };
    function collect(value: unknown, sensitive = false, depth = 0): void {
        if (depth > 20) return;
        if (typeof value === 'string') {
            if (sensitive) remember(value);
            else if (/^[\s]*[[{]/.test(value)) {
                try {
                    collect(JSON.parse(value), false, depth + 1);
                } catch {
                    /* Ordinary text. */
                }
            }
            return;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        try {
            for (const [key, item] of Object.entries(value)) {
                collect(item, sensitive || SENSITIVE_KEY.test(key), depth + 1);
                if (typeof item === 'string' && /authorization/i.test(key)) remember(item.replace(/^(?:AccessToken=|Bearer\s+)/i, ''));
                if (typeof item === 'string' && /cookie/i.test(key)) {
                    for (const cookie of item.split(';')) {
                        const equals = cookie.indexOf('=');
                        if (equals >= 0) remember(cookie.slice(equals + 1).trim());
                    }
                }
            }
        } finally {
            seen.delete(value);
        }
    }
    for (const input of inputs) collect(input);
    const values = [...secrets].sort((left, right) => right.length - left.length);
    const text = (value: string): string => values.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), value);
    function replace(value: unknown): unknown {
        if (typeof value === 'string') return text(value);
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(replace);
        const result: Record<string, unknown> = Object.create(null);
        for (const [key, item] of Object.entries(value)) result[text(key)] = replace(item);
        return result;
    }
    return (value) => replace(redactForLogs(value));
}

/** Keep useful error identity fields without retaining secret-bearing Axios config, stack or cause. */
export function redactedRequestError(error: unknown, redact: (value: unknown) => unknown, detail?: string, status?: number): Error {
    const message = String(redact(detail ?? (error instanceof Error ? error.message : String(error))));
    if (
        detail === undefined &&
        error instanceof Error &&
        message === error.message &&
        redact(error.stack) === error.stack &&
        !('cause' in error) &&
        !('config' in error) &&
        !('request' in error) &&
        !('response' in error)
    )
        return error;
    const safe = new Error(message);
    if (error instanceof Error) safe.name = String(redact(error.name));
    if (error && typeof error === 'object') {
        const source = error as { code?: unknown; status?: unknown };
        if (typeof source.code === 'string' || typeof source.code === 'number') Object.assign(safe, { code: redact(source.code) });
        const errorStatus = status ?? source.status;
        if (typeof errorStatus === 'number' && Number.isFinite(errorStatus)) Object.assign(safe, { status: errorStatus });
    }
    return safe;
}
