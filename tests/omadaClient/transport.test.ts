import type { AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager, WebAuthManager } from '../../src/omadaClient/auth.js';
import { InternalAuthManager } from '../../src/omadaClient/internalAuth.js';
import { InternalRequestHandler } from '../../src/omadaClient/internalRequest.js';
import { RequestHandler } from '../../src/omadaClient/request.js';
import { controllerRequest } from '../../src/omadaClient/transport.js';

const failure = (status?: number, headers = {}, code?: string) =>
    Object.assign(new Error('Controller unavailable'), {
        isAxiosError: true,
        code,
        ...(status === undefined ? {} : { response: { status, headers } }),
    });
const success = { status: 200, data: { errorCode: 0, result: {} } };

describe('controller transport policy', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-09T01:00:00Z'));
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('paces public and internal starts together after a slow shared authentication', async () => {
        const starts: number[] = [];
        const http = {
            defaults: {},
            request: vi.fn(() => {
                starts.push(Date.now());
                return Promise.resolve(success);
            }),
        } as unknown as AxiosInstance;
        const headers = new Promise<Record<string, string>>((resolve) => setTimeout(() => resolve({ 'Csrf-Token': 'session' }), 1000));
        const auth = { getAuthHeaders: () => headers, clearToken: vi.fn(), clearSession: vi.fn() };
        const open = new RequestHandler(http, auth);
        const internal = new InternalRequestHandler(http, auth as unknown as InternalAuthManager, 'controller');
        const initial = Date.now();
        const requests = Promise.all([open.get('/a'), internal.get('/b'), open.get('/c')]);
        await vi.advanceTimersByTimeAsync(999);
        expect(starts).toEqual([]);
        await vi.advanceTimersByTimeAsync(251);
        await requests;
        expect(starts.map((time) => time - initial)).toEqual([1000, 1125, 1250]);
    });

    it('does not pace different controller instances together', async () => {
        const first = { defaults: {}, request: vi.fn().mockResolvedValue(success) } as unknown as AxiosInstance;
        const second = { defaults: {}, request: vi.fn().mockResolvedValue(success) } as unknown as AxiosInstance;
        await Promise.all([controllerRequest(first, { method: 'GET' }), controllerRequest(second, { method: 'GET' })]);
        expect(first.request).toHaveBeenCalledTimes(1);
        expect(second.request).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([429, 502, 503, 504])('bounds retries for HTTP %s', async (status) => {
        const http = { defaults: {}, request: vi.fn().mockRejectedValue(failure(status)) } as unknown as AxiosInstance;
        const result = expect(controllerRequest(http, { method: 'GET' })).rejects.toThrow('Controller unavailable');
        await vi.runAllTimersAsync();
        await result;
        expect(http.request).toHaveBeenCalledTimes(3);
    });

    it.each(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'])('retries safe reads after %s', async (code) => {
        const http = {
            defaults: {},
            request: vi
                .fn()
                .mockRejectedValueOnce(failure(undefined, {}, code))
                .mockResolvedValue(success),
        } as unknown as AxiosInstance;
        const result = controllerRequest(http, { method: 'HEAD' });
        await vi.runAllTimersAsync();
        await expect(result).resolves.toBe(success);
        expect(http.request).toHaveBeenCalledTimes(2);
    });

    it.each(['2', new Date('2026-11-09T01:00:02Z').toUTCString()])('honors Retry-After %s', async (header) => {
        const http = {
            defaults: {},
            request: vi
                .fn()
                .mockRejectedValueOnce(failure(429, { 'retry-after': header }))
                .mockResolvedValue(success),
        } as unknown as AxiosInstance;
        const result = controllerRequest(http, { method: 'GET' });
        await vi.advanceTimersByTimeAsync(1999);
        expect(http.request).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await result;
        expect(http.request).toHaveBeenCalledTimes(2);
    });

    it('does not shorten excessive Retry-After or retry ordinary permission failures', async () => {
        for (const error of [failure(429, { 'retry-after': '31' }), failure(403), failure(undefined, {}, 'ENOTFOUND')]) {
            const http = { defaults: {}, request: vi.fn().mockRejectedValue(error) } as unknown as AxiosInstance;
            await expect(controllerRequest(http, { method: 'GET' })).rejects.toBe(error);
            expect(http.request).toHaveBeenCalledTimes(1);
        }
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('does not replay an uncertain %s', async (method) => {
        const http = { defaults: {}, request: vi.fn().mockRejectedValue(failure(undefined, {}, 'ECONNRESET')) } as unknown as AxiosInstance;
        await expect(controllerRequest(http, { method })).rejects.toThrow('Controller unavailable');
        expect(http.request).toHaveBeenCalledTimes(1);
    });

    it('honors explicitly disabled retry for reads', async () => {
        const http = { defaults: {}, request: vi.fn().mockRejectedValue(failure(503)) } as unknown as AxiosInstance;
        await expect(controllerRequest(http, { method: 'GET' }, false)).rejects.toThrow();
        expect(http.request).toHaveBeenCalledTimes(1);
    });

    it('cancels a backoff immediately without another dispatch', async () => {
        const abort = new AbortController();
        const http = { defaults: {}, request: vi.fn().mockRejectedValue(failure(503)) } as unknown as AxiosInstance;
        const result = expect(controllerRequest(http, { method: 'GET', signal: abort.signal })).rejects.toMatchObject({ code: 'ERR_CANCELED' });
        await vi.advanceTimersByTimeAsync(10);
        abort.abort();
        await result;
        await vi.advanceTimersByTimeAsync(2000);
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels a queued caller immediately and preserves later queue work', async () => {
        const abort = new AbortController();
        const http = { defaults: {}, request: vi.fn().mockResolvedValue(success) } as unknown as AxiosInstance;
        await controllerRequest(http, { method: 'GET' });
        const preceding = controllerRequest(http, { method: 'GET' });
        const canceled = expect(controllerRequest(http, { method: 'GET', signal: abort.signal })).rejects.toMatchObject({ code: 'ERR_CANCELED' });
        const following = controllerRequest(http, { method: 'GET' });
        abort.abort();
        await canceled;
        expect(http.request).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        await Promise.all([preceding, following]);
        expect(http.request).toHaveBeenCalledTimes(3);
    });

    it('uses the Axios default timeout as a budget across backoff', async () => {
        const http = { defaults: { timeout: 300 }, request: vi.fn().mockRejectedValue(failure(503)) } as unknown as AxiosInstance;
        const result = expect(controllerRequest(http, { method: 'GET' })).rejects.toThrow('timeout budget exhausted');
        await vi.advanceTimersByTimeAsync(300);
        await result;
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('expires a queued request without dispatch and keeps the queue usable', async () => {
        const http = { defaults: {}, request: vi.fn().mockResolvedValue(success) } as unknown as AxiosInstance;
        await controllerRequest(http, { method: 'GET' });
        const expired = expect(controllerRequest(http, { method: 'GET', timeout: 50 })).rejects.toThrow('timeout budget exhausted');
        await vi.advanceTimersByTimeAsync(50);
        await expired;
        expect(http.request).toHaveBeenCalledTimes(1);
        const following = controllerRequest(http, { method: 'GET' });
        await vi.runAllTimersAsync();
        await following;
        expect(http.request).toHaveBeenCalledTimes(2);
    });

    it('passes only the remaining request budget to a retried dispatch', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const http = { defaults: {}, request: vi.fn().mockRejectedValueOnce(failure(503)).mockResolvedValue(success) } as unknown as AxiosInstance;
        const result = controllerRequest(http, { method: 'GET', timeout: 1000 });
        await vi.advanceTimersByTimeAsync(500);
        await result;
        expect(http.request).toHaveBeenNthCalledWith(1, expect.objectContaining({ timeout: 1000 }));
        expect(http.request).toHaveBeenNthCalledWith(2, expect.objectContaining({ timeout: 500 }));
    });

    it('adds bounded jitter to fallback backoff without shortening Retry-After', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.8);
        const http = { defaults: {}, request: vi.fn().mockRejectedValueOnce(failure(503)).mockResolvedValue(success) } as unknown as AxiosInstance;
        const result = controllerRequest(http, { method: 'GET' });
        await vi.advanceTimersByTimeAsync(599);
        expect(http.request).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await result;
        expect(http.request).toHaveBeenCalledTimes(2);
    });

    it('bounds an in-flight request and does not retry after the overall deadline', async () => {
        const http = { defaults: {}, request: vi.fn(() => new Promise(() => undefined)) } as unknown as AxiosInstance;
        const result = expect(controllerRequest(http, { method: 'GET', timeout: 200 })).rejects.toThrow('timeout budget exhausted');
        await vi.advanceTimersByTimeAsync(200);
        await result;
        expect(http.request).toHaveBeenCalledTimes(1);
    });

    it('preserves the deadline across authentication refresh', async () => {
        const http = { defaults: {}, request: vi.fn().mockRejectedValue(failure(401)) } as unknown as AxiosInstance;
        const auth = {
            getAuthHeaders: vi
                .fn()
                .mockResolvedValueOnce({ Authorization: 'old' })
                .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ Authorization: 'new' }), 200))),
            clearToken: vi.fn(),
        };
        const handler = new RequestHandler(http, auth);
        const result = expect(handler.request({ method: 'GET', url: '/test', timeout: 150 })).rejects.toThrow('timeout budget exhausted');
        await vi.advanceTimersByTimeAsync(150);
        await result;
        await vi.advanceTimersByTimeAsync(50);
        expect(http.request).toHaveBeenCalledTimes(1);
    });

    it.each(['public', 'internal'])('%s distinguishes forbidden access from expired authentication', async (surface) => {
        const http = { defaults: {}, request: vi.fn() } as unknown as AxiosInstance;
        const auth = { getAuthHeaders: vi.fn().mockResolvedValue({ 'Csrf-Token': 'token' }), clearToken: vi.fn(), clearSession: vi.fn() };
        const handler =
            surface === 'public'
                ? new RequestHandler(http, auth)
                : new InternalRequestHandler(http, auth as unknown as InternalAuthManager, 'controller');
        vi.mocked(http.request).mockRejectedValue(failure(403));
        await expect(handler.get('/restricted')).rejects.toThrow('HTTP 403');
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(auth.clearToken).not.toHaveBeenCalled();
        expect(auth.clearSession).not.toHaveBeenCalled();

        vi.mocked(http.request)
            .mockRejectedValueOnce(Object.assign(failure(403), { response: { status: 403, data: { errorCode: -44106 } } }))
            .mockResolvedValue(success);
        const result = handler.get('/expired');
        await vi.runAllTimersAsync();
        await expect(result).resolves.toEqual(success.data);
        expect(http.request).toHaveBeenCalledTimes(3);
        expect(surface === 'public' ? auth.clearToken : auth.clearSession).toHaveBeenCalledTimes(1);
    });
});

describe.each(['oauth', 'web', 'internal'] as const)('%s credential rejection cooldown', (mode) => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const create = (http: AxiosInstance) => {
        if (mode === 'oauth') return new AuthManager(http, 'client', 'secret', 'controller');
        if (mode === 'web') return new WebAuthManager(http, 'user', 'password', 'controller');
        return new InternalAuthManager(http, 'user', 'password', 'controller');
    };
    const valid = {
        data: { errorCode: 0, result: { accessToken: 'token', expiresIn: 3600, token: 'csrf' } },
        headers: { 'set-cookie': ['SESSION=cookie'] },
    };

    it('bounds repeated rejected logins, then permits recovery', async () => {
        const http = {
            post: vi
                .fn()
                .mockResolvedValueOnce({ data: { errorCode: -1, msg: 'Invalid credentials' }, headers: {} })
                .mockResolvedValue(valid),
            defaults: {},
        } as unknown as AxiosInstance;
        const auth = create(http);
        const failures = await Promise.allSettled(Array.from({ length: 4 }, () => auth.getAuthHeaders()));
        expect(failures.every((result) => result.status === 'rejected')).toBe(true);
        await expect(auth.getAuthHeaders()).rejects.toThrow('cooling down');
        expect(http.post).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(3000);
        await expect(auth.getAuthHeaders()).resolves.toBeDefined();
        expect(http.post).toHaveBeenCalledTimes(2);
    });

    it('cools down after an HTTP credential rejection', async () => {
        const http = { post: vi.fn().mockRejectedValue(failure(401)), defaults: {} } as unknown as AxiosInstance;
        const auth = create(http);
        await expect(auth.getAuthHeaders()).rejects.toThrow('Controller unavailable');
        await expect(auth.getAuthHeaders()).rejects.toThrow('cooling down');
        expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('does not cache network failures as rejected credentials', async () => {
        const http = {
            post: vi
                .fn()
                .mockRejectedValueOnce(failure(undefined, {}, 'ECONNRESET'))
                .mockResolvedValue(valid),
            defaults: {},
        } as unknown as AxiosInstance;
        const auth = create(http);
        await expect(auth.getAuthHeaders()).rejects.toThrow('Controller unavailable');
        await expect(auth.getAuthHeaders()).resolves.toBeDefined();
        expect(http.post).toHaveBeenCalledTimes(2);
    });

    it('does not let an obsolete credential rejection block the replacement generation', async () => {
        let resolveOld!: (value: unknown) => void;
        const old = new Promise((resolve) => {
            resolveOld = resolve;
        });
        const http = { post: vi.fn().mockReturnValueOnce(old).mockResolvedValue(valid), defaults: {} } as unknown as AxiosInstance;
        const auth = create(http);
        const first = auth.getAuthHeaders();
        if ('clearToken' in auth) auth.clearToken();
        else auth.clearSession();
        await auth.getAuthHeaders();
        resolveOld({ data: { errorCode: -1, msg: 'Invalid credentials' }, headers: {} });
        await expect(first).resolves.toBeDefined();
        await expect(auth.getAuthHeaders()).resolves.toBeDefined();
        expect(http.post).toHaveBeenCalledTimes(2);
    });
});
