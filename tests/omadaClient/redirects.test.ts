import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';

import axios from 'axios';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthManager } from '../../src/omadaClient/auth.js';
import { createControllerHttpOptions } from '../../src/omadaClient/httpOptions.js';
import { InternalAuthManager } from '../../src/omadaClient/internalAuth.js';
import { InternalRequestHandler } from '../../src/omadaClient/internalRequest.js';
import { RequestHandler } from '../../src/omadaClient/request.js';

// Fixed port permits the local workload guard to reserve this acceptance fixture.
const PORT = 43187;
const baseUrl = `http://127.0.0.1:${PORT}`;

describe('controller redirect refusal', () => {
    const received: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
    let redirectLogin = false;
    let recoverSession: false | 'redirect' | 'html' = false;
    let recoveryRequests = 0;
    const server = createServer((request, response) => {
        const url = request.url ?? '';
        received.push({ url, headers: request.headers });
        request.resume();
        response.setHeader('Content-Type', 'application/json');
        if (!redirectLogin && url.startsWith('/openapi/authorize/token')) {
            response.end(JSON.stringify({ errorCode: 0, result: { accessToken: 'test-token', expiresIn: 3600 } }));
        } else if (!redirectLogin && url === '/controller/api/v2/login') {
            response.setHeader('Set-Cookie', 'TPOMADA_SESSIONID=test-session; HttpOnly');
            response.end(JSON.stringify({ errorCode: 0, result: { token: 'test-csrf' } }));
        } else if (recoverSession && ['/controller/api/v2/sites', '/controller/api/v2/settings'].includes(url)) {
            if (recoveryRequests++ === 0) {
                if (recoverSession === 'redirect') {
                    response.writeHead(302, { Location: `${baseUrl}/controller/login?private=never-returned` });
                    response.end();
                } else {
                    response.setHeader('Content-Type', 'text/html');
                    response.end('<html><form method=post action=/controller/api/v2/login><input name=username><input type=password></form></html>');
                }
            } else {
                response.end(JSON.stringify({ errorCode: 0, result: { recovered: true } }));
            }
        } else {
            response.writeHead(302, { Location: `${baseUrl}/unexpected-destination` });
            response.end(JSON.stringify({ msg: 'Use the configured controller URL' }));
        }
    });

    beforeAll(async () => {
        server.listen(PORT, '127.0.0.1');
        await once(server, 'listening');
    });

    afterAll(async () => {
        if (server.listening) {
            server.close();
            await once(server, 'close');
        }
    });

    beforeEach(() => {
        received.length = 0;
        redirectLogin = false;
        recoverSession = false;
        recoveryRequests = 0;
    });

    const http = () => axios.create({ ...createControllerHttpOptions({ baseUrl, strictSsl: true, requestTimeout: 1000 }), proxy: false });

    it('does not replay an OAuth authenticated write and preserves the HTTP error details', async () => {
        const transport = http();
        const auth = new AuthManager(transport, 'client', 'secret', 'controller');
        const request = new RequestHandler(transport, auth);

        await expect(request.post('/openapi/write', { enabled: true })).rejects.toThrow(
            'POST /openapi/write (HTTP 302) - Use the configured controller URL'
        );
        expect(received.map(({ url }) => url)).toEqual(['/openapi/authorize/token?grant_type=client_credentials', '/openapi/write']);
        expect(received[1].headers.authorization).toBe('AccessToken=test-token');
    });

    it('does not forward internal session cookies or CSRF tokens to a redirected destination', async () => {
        const transport = http();
        const auth = new InternalAuthManager(transport, 'admin', 'password', 'controller');
        const request = new InternalRequestHandler(transport, auth, 'controller');

        await expect(request.get('/sites')).rejects.toThrow(
            'GET /controller/api/v2/sites (HTTP 302) - Redirect refused; use the configured controller URL.'
        );
        expect(received.map(({ url }) => url)).toEqual(['/controller/api/v2/login', '/controller/api/v2/sites']);
        expect(received[1].headers.cookie).toBe('TPOMADA_SESSIONID=test-session');
        expect(received[1].headers['csrf-token']).toBe('test-csrf');
    });

    it.each(['redirect', 'html'] as const)('recovers internal reads from a proven %s login response without following it', async (kind) => {
        recoverSession = kind;
        const transport = http();
        const auth = new InternalAuthManager(transport, 'admin', 'password', 'controller');
        const request = new InternalRequestHandler(transport, auth, 'controller');
        await expect(request.get('/sites')).resolves.toEqual({ errorCode: 0, result: { recovered: true } });
        expect(received.map(({ url }) => url)).toEqual([
            '/controller/api/v2/login',
            '/controller/api/v2/sites',
            '/controller/api/v2/login',
            '/controller/api/v2/sites',
        ]);
        expect(received.filter(({ url }) => url.includes('private=') || url === '/controller/login')).toEqual([]);
    });

    it('does not replay an internal mutation; the next explicit read obtains a new session', async () => {
        recoverSession = 'redirect';
        const transport = http();
        const auth = new InternalAuthManager(transport, 'admin', 'password', 'controller');
        const request = new InternalRequestHandler(transport, auth, 'controller');
        await expect(request.post('/settings', { enabled: false })).rejects.toThrow('write outcome is unverified');
        expect(received.map(({ url }) => url)).toEqual(['/controller/api/v2/login', '/controller/api/v2/settings']);
        await expect(request.get('/sites')).resolves.toEqual({ errorCode: 0, result: { recovered: true } });
        expect(received.map(({ url }) => url)).toEqual([
            '/controller/api/v2/login',
            '/controller/api/v2/settings',
            '/controller/api/v2/login',
            '/controller/api/v2/sites',
        ]);
    });

    it('also refuses redirects while sending OAuth and internal login credentials', async () => {
        redirectLogin = true;
        const transport = http();
        await expect(new AuthManager(transport, 'client', 'secret', 'controller').getAccessToken()).rejects.toMatchObject({
            response: { status: 302 },
        });
        await expect(new InternalAuthManager(transport, 'admin', 'password', 'controller').getAuthHeaders()).rejects.toMatchObject({
            response: { status: 302 },
        });
        expect(received.map(({ url }) => url)).toEqual(['/openapi/authorize/token?grant_type=client_credentials', '/controller/api/v2/login']);
    });
});

describe('controller private CA TLS verification', () => {
    // Public test-only certificate/key, valid 2020–2120 and issued for localhost only.
    const fixture = (name: string) => new URL(`../fixtures/tls/${name}`, import.meta.url);
    const server = createHttpsServer(
        { key: readFileSync(fixture('localhost-key.pem')), cert: readFileSync(fixture('localhost.pem')) },
        (_request, response) => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ errorCode: 0, result: { ok: true } }));
        }
    );

    beforeAll(async () => {
        server.listen(PORT, '127.0.0.1');
        await once(server, 'listening');
    });

    afterAll(async () => {
        if (server.listening) {
            server.close();
            await once(server, 'close');
        }
    });

    const http = (hostname: string, caFile?: string) =>
        axios.create({
            ...createControllerHttpOptions({ baseUrl: `https://${hostname}:${PORT}`, strictSsl: true, requestTimeout: 1000, caFile }),
            family: 4,
            proxy: false,
        });

    it('rejects the private certificate without the supplied CA', async () => {
        await expect(http('localhost').get('/')).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    });

    it('successfully verifies the TLS handshake with the supplied CA', async () => {
        const response = await http('localhost', fileURLToPath(fixture('ca.pem'))).get('/');
        expect(response.status).toBe(200);
        expect(response.data).toEqual({ errorCode: 0, result: { ok: true } });
    });

    it('still rejects the wrong hostname when its issuing CA is trusted', async () => {
        await expect(http('127.0.0.1', fileURLToPath(fixture('ca.pem'))).get('/')).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    });
});
