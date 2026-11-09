import { describe, expect, it } from 'vitest';
import { safeSerialize } from '../../src/server/common.js';
import { createRequestRedactor, redactedRequestError } from '../../src/utils/redact.js';

describe('tool log redaction', () => {
    it('redacts nested credentials and JSON body strings while keeping operational values', () => {
        const encoded = safeSerialize({
            operationId: 'adoptDevice',
            params: { siteId: 'test-site' },
            body: { username: 'admin', password: 'top-secret', nested: [{ clientSecret: 'secret', port: 3 }] },
            json: '{"psk":"wifi-secret"}',
        });
        expect(encoded).not.toContain('top-secret');
        expect(encoded).not.toContain('wifi-secret');
        expect(encoded).toContain('test-site');
        expect(encoded).toContain('adoptDevice');
        expect(JSON.parse(encoded).body.nested[0].port).toBe(3);
    });
    it('retains special keys without prototype changes and handles circular data', () => {
        const input = JSON.parse('{"__proto__":{"password":"secret"}}');
        const result = JSON.parse(safeSerialize(input));
        expect(Object.hasOwn(result, '__proto__')).toBe(true);
        expect(result.__proto__.password).toBe('[redacted]');
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(safeSerialize(cyclic)).toContain('[circular]');
    });
});

describe('request-scoped secret redaction', () => {
    it('fully masks secret echoes in ordinary text, encoded bodies and response keys', () => {
        const secret = 'wireless-"secret"-value';
        const redact = createRequestRedactor(
            { pskSetting: { securityKey: secret } },
            { password: 'query-value' },
            { Authorization: 'AccessToken=auth-value', Cookie: 'SESSION=cookie-value' }
        );
        const result = JSON.stringify(
            redact({
                msg: `Rejected ${secret}; query-value auth-value cookie-value`,
                nested: JSON.stringify({ msg: secret }),
                [secret]: 'echo',
                health: { retries: 7 },
            })
        );
        for (const value of [secret, JSON.stringify(secret).slice(1, -1), 'query-value', 'auth-value', 'cookie-value'])
            expect(result).not.toContain(value);
        expect(result).toContain('"retries":7');
    });

    it('collects credentials from a JSON body string and does not modify its inputs', () => {
        const input = { secretkey: 'submitted-credential', channel: 36 };
        const redact = createRequestRedactor(JSON.stringify(input));
        expect(redact('Rejected submitted-credential')).toBe('Rejected [redacted]');
        expect(input).toEqual({ secretkey: 'submitted-credential', channel: 36 });
        expect(redact({ name: 'AP', channel: 36 })).toEqual({ name: 'AP', channel: 36 });
    });

    it('collects aliased sensitive objects and strips original error stack/cause/config', () => {
        const alias = { value: 'aliased-secret' };
        const redact = createRequestRedactor({ ordinary: alias, credentials: alias });
        const original = Object.assign(new Error('Rejected aliased-secret'), {
            code: 'ERR_BAD_REQUEST',
            status: 400,
            cause: new Error('aliased-secret'),
            config: { password: 'aliased-secret' },
        });
        const safe = redactedRequestError(original, redact);
        expect(`${safe.message}\n${safe.stack}\n${JSON.stringify(safe)}`).not.toContain('aliased-secret');
        expect(safe).toMatchObject({ code: 'ERR_BAD_REQUEST', status: 400 });
        expect(safe).not.toHaveProperty('cause');
        expect(safe).not.toHaveProperty('config');
    });
});
