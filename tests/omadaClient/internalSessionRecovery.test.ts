import type { AxiosInstance, AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalAuthManager } from '../../src/omadaClient/internalAuth.js';
import { InternalRequestHandler } from '../../src/omadaClient/internalRequest.js';
import { logger } from '../../src/utils/logger.js';

const success = { status: 200, data: { errorCode: 0, result: {} }, headers: {} };
const html =
    '<html><form action="/controller/api/v2/login" method="post"><input name="username"><input type="password" name="password"></form></html>';
const redirect = (location: string, status = 302) =>
    Object.assign(new Error('Request rejected'), {
        isAxiosError: true,
        response: { status, headers: { location }, data: '' },
    });
function setup() {
    const http = { defaults: { baseURL: 'https://controller.test', timeout: 1000 }, request: vi.fn() };
    const auth = {
        getAuthHeaders: vi.fn().mockResolvedValue({ 'Csrf-Token': 'matching-token', Cookie: 'session=matching-cookie' }),
        clearSession: vi.fn(),
    };
    const request = new InternalRequestHandler(http as unknown as AxiosInstance, auth as unknown as InternalAuthManager, 'controller');
    return { http, auth, request };
}
afterEach(() => vi.restoreAllMocks());

describe('bounded internal session recovery', () => {
    it.each([
        '/controller/login',
        '/login',
        'https://controller.test/controller/login',
        'http://controller.test/controller/login?redirect=private-value',
    ])('renews a safe read on recognized login redirect %s without following it', async (location) => {
        const { http, auth, request } = setup();
        http.request.mockRejectedValueOnce(redirect(location)).mockResolvedValueOnce(success);
        await expect(request.get('/sites')).resolves.toEqual(success.data);
        expect(auth.clearSession).toHaveBeenCalledExactlyOnceWith('matching-token');
        expect(http.request).toHaveBeenCalledTimes(2);
        for (const [config] of http.request.mock.calls) {
            expect(config).toMatchObject({ method: 'GET', url: '/controller/api/v2/sites', maxRedirects: 0 });
            expect(config.url).not.toBe(location);
        }
        expect(http.defaults.baseURL).toBe('https://controller.test');
    });
    it.each([
        'https://other.test/controller/login',
        '//other.test/controller/login',
        'https://controller.test:8443/controller/login',
        'https://user:password@controller.test/controller/login',
        '/other/login',
        '/controller/not-login',
        '/controller/login/extra',
        '/controller/%6cogin',
        '/controller/login\n',
        '/controller\\login',
        'javascript:alert(1)',
    ])('does not mistake another redirect for session expiry: %s', async (location) => {
        const { http, auth, request } = setup();
        http.request.mockRejectedValue(redirect(location));
        await expect(request.get('/sites')).rejects.toThrow('Redirect refused');
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(auth.clearSession).not.toHaveBeenCalled();
    });
    it('bounds persistent redirects to one renewal and hides redirect query details', async () => {
        const { http, auth, request } = setup();
        const secret = 'unexpected-redirect-secret';
        const logs = [vi.spyOn(logger, 'info'), vi.spyOn(logger, 'debug'), vi.spyOn(logger, 'warn'), vi.spyOn(logger, 'error')];
        for (const log of logs) log.mockImplementation(() => undefined);
        http.request.mockRejectedValue(
            Object.assign(redirect(`/controller/login?token=${secret}`), {
                message: secret,
                response: {
                    status: 302,
                    headers: { location: `/controller/login?token=${secret}` },
                    data: { errorCode: -1, msg: `Location=${secret}` },
                },
            })
        );
        const failure = request.get('/sites');
        await expect(failure).rejects.toThrow('HTTP 302');
        await failure.catch((error: Error) => expect(`${error.message}${error.stack}${JSON.stringify(error)}`).not.toContain(secret));
        expect(auth.clearSession).toHaveBeenCalledTimes(1);
        expect(http.request).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(secret);
    });
    it.each([
        html,
        "<html><form method='POST' action='/controller/login'><input name='account'><input type='PASSWORD'></form></html>",
        '<html><form method=post action=/login><input name=user><input type=password></form></html>',
    ])('recovers only a bounded positively identified login form', async (data) => {
        const { http, auth, request } = setup();
        http.request
            .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data })
            .mockResolvedValueOnce(success);
        await expect(request.get('/sites')).resolves.toEqual(success.data);
        expect(auth.clearSession).toHaveBeenCalledExactlyOnceWith('matching-token');
        expect(http.request).toHaveBeenCalledTimes(2);
    });
    it.each([
        { status: 200, headers: { 'content-type': 'text/html' }, data: '<html>Not found</html>' },
        { status: 200, headers: { 'content-type': 'text/html' }, data: html.replace('/controller/api/v2/login', 'https://other.test/login') },
        { status: 200, headers: { 'content-type': 'text/html' }, data: html.replace('method="post"', 'method="get"') },
        { status: 200, headers: { 'content-type': 'application/json' }, data: html },
        { status: 200, headers: {}, data: { result: [] } },
        { status: 200, headers: {}, data: { errorCode: '0', result: [] } },
        { status: 200, headers: {}, data: { errorCode: null } },
        { status: 200, headers: { 'content-type': 'text/html' }, data: html + 'x'.repeat(65536) },
    ])('rejects unrecognized non-API responses without renewal', async (response) => {
        const { http, auth, request } = setup();
        http.request.mockResolvedValue(response);
        await expect(request.get('/sites')).rejects.toThrow('without a valid errorCode');
        expect(auth.clearSession).not.toHaveBeenCalled();
        expect(http.request).toHaveBeenCalledTimes(1);
    });
    it.each([
        '<form data-note="example method=post action=/controller/login" method="get" action="/search">',
        "<form data-note='example method=post action=/controller/login' method='get' action='/search'>",
        '<form data-note="example > method=post action=/controller/login" method="get" action="/search">',
        '<form method="get" method="post" action="/controller/login">',
        '<form method="post" action="/search" action="/controller/login">',
        '<form method="post" action="/controller/login"><input name="username"><input data-note="type=password" type="text">',
    ])('does not authenticate from attribute text inside quoted values or overridden duplicate attributes', async (form) => {
        const { http, auth, request } = setup();
        http.request.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'text/html' },
            data: `<html>${form}<input name="username">${form.includes('data-note="type=password"') ? '' : '<input type="password">'}</form></html>`,
        });
        await expect(request.get('/sites')).rejects.toThrow('Unexpected HTML');
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(auth.clearSession).not.toHaveBeenCalled();
    });
    it.each([
        `<!-- ${html} -->`,
        `<script>const example = ${JSON.stringify(html)};</script>`,
        `<textarea>${html}</textarea>`,
        `<template>${html}</template>`,
        `<!-- ${html}`,
        `<script>${html}`,
    ])('does not infer an active login form from inert markup', async (data) => {
        const { http, auth, request } = setup();
        http.request.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data });
        await expect(request.get('/sites')).rejects.toThrow('Unexpected HTML');
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(auth.clearSession).not.toHaveBeenCalled();
    });
    it('still recognizes a real login form around comments and scripts', async () => {
        const { http, auth, request } = setup();
        const data = `<script>const example = ${JSON.stringify(html)};</script><!-- ignored -->${html}`;
        http.request.mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'text/html' }, data }).mockResolvedValueOnce(success);
        await expect(request.get('/sites')).resolves.toEqual(success.data);
        expect(auth.clearSession).toHaveBeenCalledTimes(1);
        expect(http.request).toHaveBeenCalledTimes(2);
    });
    it('does not mistake a data-action attribute for a real login action', async () => {
        const { http, auth, request } = setup();
        http.request.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: html.replace('action=', 'data-action=') });
        await expect(request.get('/sites')).rejects.toThrow('Unexpected');
        expect(auth.clearSession).not.toHaveBeenCalled();
    });
    it('does not log or return the body of a login page when renewal fails', async () => {
        const { http, auth, request } = setup();
        const secret = 'unrelated-page-secret';
        const logs = [vi.spyOn(logger, 'debug'), vi.spyOn(logger, 'error')];
        for (const log of logs) log.mockImplementation(() => undefined);
        http.request.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: html.replace('</html>', `${secret}</html>`) });
        const failure = request.get('/sites');
        await expect(failure).rejects.toThrow('Unexpected HTML');
        await failure.catch((error: Error) => expect(`${error.message}${error.stack}${JSON.stringify(error)}`).not.toContain(secret));
        expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(secret);
        expect(auth.clearSession).toHaveBeenCalledTimes(1);
        expect(http.request).toHaveBeenCalledTimes(2);
    });
    it.each(['post', 'put', 'delete'] as const)('never replays %s after a recognized login redirect', async (method) => {
        const { http, auth, request } = setup();
        http.request.mockRejectedValue(redirect('/controller/login'));
        const result = method === 'delete' ? request.delete('/settings') : request[method]('/settings', { enabled: false });
        await expect(result).rejects.toThrow('write outcome is unverified');
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(auth.clearSession).toHaveBeenCalledExactlyOnceWith('matching-token');
    });
    it.each([
        { status: 200, headers: {}, data: { errorCode: -44106, msg: 'Session expired' } },
        { status: 200, headers: { 'content-type': 'text/html' }, data: html },
    ])('invalidates known rejected sessions on a write without replaying', async (response) => {
        const { http, auth, request } = setup();
        http.request.mockResolvedValue(response);
        await expect(request.put('/settings', { enabled: true })).rejects.toThrow('request was not replayed');
        expect(http.request).toHaveBeenCalledTimes(1);
        expect(auth.clearSession).toHaveBeenCalledExactlyOnceWith('matching-token');
    });
    it('also refuses automatic mutation replay on HTTP 401', async () => {
        const { http, auth, request } = setup();
        http.request.mockRejectedValue(Object.assign(new Error('Unauthorized'), { isAxiosError: true, response: { status: 401 } }));
        await expect(request.post('/settings', {})).rejects.toThrow('write outcome is unverified');
        expect(auth.clearSession).toHaveBeenCalledExactlyOnceWith('matching-token');
        expect(http.request).toHaveBeenCalledTimes(1);
    });
    it('leaves ordinary permission denials alone, including HTML 403 responses', async () => {
        const { http, auth, request } = setup();
        http.request.mockRejectedValue(
            Object.assign(new Error('Forbidden'), {
                isAxiosError: true,
                response: { status: 403, headers: { 'content-type': 'text/html' }, data: html },
            })
        );
        await expect(request.get('/restricted')).rejects.toThrow('HTTP 403');
        expect(auth.clearSession).not.toHaveBeenCalled();
        expect(http.request).toHaveBeenCalledTimes(1);
    });
    it('preserves the initial timeout budget across renewal', async () => {
        const { http, request } = setup();
        http.request.mockRejectedValueOnce(redirect('/controller/login')).mockResolvedValueOnce(success);
        await request.get('/sites');
        expect(http.request.mock.calls[1][0].timeout).toBeLessThanOrEqual(http.request.mock.calls[0][0].timeout);
    });
});
