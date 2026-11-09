import { describe, expect, it } from 'vitest';
import { safeSerialize } from '../../src/server/common.js';

describe('tool log redaction', () => {
    it('describes binary and multipart data without enumerating file contents', () => {
        const bytes = Buffer.alloc(1024 * 1024, 42);
        expect(safeSerialize(bytes)).toBe('{"binary":true,"byteLength":1048576}');
        const form = new FormData();
        form.append('file', new Blob(['private-file-content']), 'input.pem');
        expect(safeSerialize(form)).toBe('{"multipart":true}');
    });
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
