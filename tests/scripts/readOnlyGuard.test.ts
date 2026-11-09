import { describe, expect, it, vi } from 'vitest';

import { installReadOnlyGuard, isReadOnlyControllerRequest } from '../../scripts/read-only-guard.mjs';

const controller = { baseUrl: 'https://controller.example.test:8043', omadacId: 'controller/id' };

describe('read-only controller guard', () => {
    it.each(['GET', 'HEAD', undefined])('allows %s controller reads', (method) => {
        expect(isReadOnlyControllerRequest({ method, url: '/openapi/v1/controller/sites' }, controller)).toBe(true);
    });

    it.each(['/openapi/authorize/token', '/controller%2Fid/api/v2/login'])('allows the exact authentication POST %s', (url) => {
        expect(isReadOnlyControllerRequest({ method: 'post', url }, controller)).toBe(true);
    });

    it.each([
        { method: 'POST', url: '/openapi/v1/controller/sites/site/settings' },
        { method: 'PATCH', url: '/openapi/v1/controller/sites/site/settings' },
        { method: 'DELETE', url: '/openapi/authorize/token' },
        { method: 'POST', url: '/another-controller/api/v2/login' },
        { method: 'POST', url: '/openapi/authorize/token/extra' },
        { method: 'POST', url: 'https://another.example.test/openapi/authorize/token' },
        { method: 'GET', url: 'https://another.example.test/data' },
        { method: 'GET', url: 'http://[' },
    ])('blocks writes and out-of-controller requests (%j)', (request) => {
        expect(isReadOnlyControllerRequest(request, controller)).toBe(false);
    });

    it('attaches the interceptor before client use and restores the original factory and interceptors', () => {
        let intercept: (request: { method: string; url: string }) => unknown;
        const instance = {
            interceptors: {
                request: {
                    use: vi.fn((handler) => {
                        intercept = handler;
                        return 7;
                    }),
                    eject: vi.fn(),
                },
            },
        };
        const original = vi.fn(() => instance);
        const axios = { create: original };
        const guard = installReadOnlyGuard(axios, controller);
        expect(axios.create({ baseURL: controller.baseUrl })).toBe(instance);
        expect(intercept!({ method: 'GET', url: '/data' })).toEqual({ method: 'GET', url: '/data', maxRedirects: 0 });
        expect(intercept!({ method: 'POST', url: '/openapi/authorize/token' })).toBeDefined();
        expect(() => intercept!({ method: 'POST', url: '/settings' })).toThrow('Read-only validation blocked');
        expect(guard.counts).toEqual({ reads: 1, authentication: 1, blocked: 1 });
        guard.restore();
        expect(axios.create).toBe(original);
        expect(instance.interceptors.request.eject).toHaveBeenCalledExactlyOnceWith(7);
        guard.restore();
        expect(instance.interceptors.request.eject).toHaveBeenCalledTimes(1);
    });
});
