import type { AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestAuthManager } from '../../src/omadaClient/auth.js';
import { RequestHandler } from '../../src/omadaClient/request.js';
import { logger } from '../../src/utils/logger.js';

const oldHeaders = { Authorization: 'AccessToken=old-secret' };
const newHeaders = { Authorization: 'AccessToken=new-secret' };
const expired = Buffer.from(JSON.stringify({ errorCode: -44106, msg: 'Token expired old-secret', token: 'response-secret' }));
const file = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255]);

function fixture() {
    const http = { request: vi.fn() };
    const auth = { mode: 'oauth', getAuthHeaders: vi.fn().mockResolvedValueOnce(oldHeaders).mockResolvedValue(newHeaders), clearToken: vi.fn() };
    const handler = new RequestHandler(http as unknown as AxiosInstance, auth as unknown as RequestAuthManager);
    return { http, auth, handler };
}
const response = (data: unknown, contentType?: string) => ({ status: 200, data, headers: contentType ? { 'content-type': contentType } : {} });

describe('binary response authentication envelopes', () => {
    beforeEach(() => {
        vi.spyOn(logger, 'info').mockImplementation(() => undefined);
        vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it.each([
        ['Buffer', expired],
        ['ArrayBuffer', Uint8Array.from(expired).buffer],
        ['Uint8Array', Uint8Array.from(expired)],
    ])('refreshes once for a known HTTP200 JSON auth code in %s then returns the original file bytes', async (_label, data) => {
        const { http, auth, handler } = fixture();
        http.request.mockResolvedValueOnce(response(data, 'application/json')).mockResolvedValueOnce(response(file, 'application/octet-stream'));
        const result = await handler.request({ method: 'GET', url: '/openapi/download', responseType: 'arraybuffer' });
        expect(result).toBe(file);
        expect(auth.clearToken).toHaveBeenCalledExactlyOnceWith(oldHeaders);
        expect(http.request).toHaveBeenCalledTimes(2);
        expect(http.request.mock.calls[1][0].headers).toEqual(newHeaders);
        const output = JSON.stringify([
            ...vi.mocked(logger.debug).mock.calls,
            ...vi.mocked(logger.warn).mock.calls,
            ...vi.mocked(logger.info).mock.calls,
        ]);
        for (const secret of ['old-secret', 'new-secret', 'response-secret']) expect(output).not.toContain(secret);
    });

    it('uses only the bytes within a Uint8Array view', async () => {
        const padding = Buffer.concat([Buffer.from('not JSON'), expired, Buffer.from('not JSON')]);
        const view = new Uint8Array(padding.buffer, padding.byteOffset + 8, expired.byteLength);
        const { http, auth, handler } = fixture();
        http.request.mockResolvedValueOnce(response(view)).mockResolvedValueOnce(response(file));
        expect(await handler.request({ method: 'GET', url: '/download', responseType: 'arraybuffer' })).toBe(file);
        expect(auth.clearToken).toHaveBeenCalledTimes(1);
    });

    it('accepts an object-looking prefix when a controller incorrectly labels its JSON error as a download', async () => {
        const { http, auth, handler } = fixture();
        http.request.mockResolvedValueOnce(response(expired, 'application/octet-stream')).mockResolvedValueOnce(response(file));
        await handler.request({ method: 'GET', url: '/download', responseType: 'arraybuffer' });
        expect(auth.clearToken).toHaveBeenCalledTimes(1);
    });

    it('keeps binary authentication retries bounded to one and returns the final response unchanged', async () => {
        const { http, auth, handler } = fixture();
        http.request.mockResolvedValue(response(expired, 'application/problem+json; charset=utf-8'));
        expect(await handler.request({ method: 'GET', url: '/download', responseType: 'arraybuffer' })).toBe(expired);
        expect(http.request).toHaveBeenCalledTimes(2);
        expect(auth.clearToken).toHaveBeenCalledTimes(1);
    });

    it.each([
        Buffer.from('{"errorCode":0,"msg":"token expired","config":"keep"}'),
        Buffer.from('{"errorCode":-1,"msg":"session expired"}'),
        Buffer.from('{"errorCode":-7131,"msg":"permission denied","password":"response-secret"}'),
        Buffer.from('{"errorCode":"-44106","msg":"token expired"}'),
        Buffer.from('{"errorCode":false,"msg":"token expired"}'),
        Buffer.from('{"msg":"token expired"}'),
    ])('does not refresh on valid JSON file content, unrecognized codes or permission errors', async (data) => {
        const { http, auth, handler } = fixture();
        auth.mode = 'web';
        http.request.mockResolvedValue(response(data, 'application/json'));
        expect(await handler.request({ method: 'GET', url: '/download', responseType: 'arraybuffer' })).toBe(data);
        expect(auth.clearToken).not.toHaveBeenCalled();
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('response-secret');
    });

    it('does not replay business writes for a binary permission-error envelope', async () => {
        const { http, auth, handler } = fixture();
        const denied = Buffer.from('{"errorCode":-7131,"msg":"permission denied","token":"response-secret"}');
        http.request.mockResolvedValue(response(denied, 'application/json'));
        expect(await handler.request({ method: 'POST', url: '/upload', responseType: 'arraybuffer', data: new FormData() })).toBe(denied);
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(auth.clearToken).not.toHaveBeenCalled();
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('response-secret');
    });

    it.each([file, Buffer.from(''), Buffer.from('not a JSON document')])('does not parse ordinary binary data without JSON media', async (data) => {
        const { http, auth, handler } = fixture();
        http.request.mockResolvedValue(response(data, 'application/octet-stream'));
        const parse = vi.spyOn(JSON, 'parse');
        expect(await handler.request({ method: 'GET', url: '/download', responseType: 'arraybuffer' })).toBe(data);
        expect(parse).not.toHaveBeenCalled();
        expect(auth.clearToken).not.toHaveBeenCalled();
    });

    it('leaves malformed JSON untouched and does not refresh', async () => {
        const { http, auth, handler } = fixture();
        const malformed = Buffer.from('{"errorCode":-44106,');
        http.request.mockResolvedValue(response(malformed, 'application/json'));
        expect(await handler.request({ method: 'GET', url: '/download', responseType: 'arraybuffer' })).toBe(malformed);
        expect(auth.clearToken).not.toHaveBeenCalled();
    });

    it('never parses JSON byte responses larger than one MiB', async () => {
        const { http, auth, handler } = fixture();
        const large = Buffer.concat([expired, Buffer.alloc(1024 * 1024, ' ')]);
        http.request.mockResolvedValue(response(large, 'application/json'));
        const parse = vi.spyOn(JSON, 'parse');
        expect(await handler.request({ method: 'GET', url: '/download', responseType: 'arraybuffer' })).toBe(large);
        expect(parse).not.toHaveBeenCalled();
        expect(auth.clearToken).not.toHaveBeenCalled();
    });

    it('preserves existing nonbinary response expiry-message behavior', async () => {
        const { http, auth, handler } = fixture();
        const result = { errorCode: 0, result: [] };
        auth.mode = 'web';
        http.request.mockResolvedValueOnce(response({ errorCode: -1, msg: 'session expired' })).mockResolvedValueOnce(response(result));
        expect(await handler.get('/sites')).toBe(result);
        expect(auth.clearToken).toHaveBeenCalledTimes(1);
    });
});
