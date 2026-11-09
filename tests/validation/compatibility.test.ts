import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfigFromEnv } from '../../src/config.js';
import { OmadaClient } from '../../src/omadaClient/index.js';
import { createServer } from '../../src/server/common.js';

const defaults = axios.defaults.adapter;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
    axios.defaults.adapter = defaults;
    await Promise.all(closers.splice(0).map((close) => close()));
});
const env = {
    OMADA_BASE_URL: 'https://controller.example.test',
    OMADA_OMADAC_ID: 'controller-scope',
    OMADA_CLIENT_ID: 'fixture-client',
    OMADA_CLIENT_SECRET: 'fixture-secret',
    OMADA_API_SPEC: 'live',
};
function respond(config: InternalAxiosRequestConfig, data: unknown, headers = {}) {
    return Promise.resolve({ config, data, headers, status: 200, statusText: 'OK' });
}
async function protocol(config: ReturnType<typeof loadConfigFromEnv>) {
    const server = createServer(new OmadaClient(config));
    const client = new Client({ name: 'compatibility-fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    closers.push(
        () => client.close(),
        () => server.close()
    );
    await Promise.all([client.connect(a), server.connect(b)]);
    return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
    return await client.callTool({ name, arguments: args });
}

describe('controller compatibility protocol qualification', () => {
    it('keeps MSP route, controller scope and OAuth principal distinct through real authentication and MCP execution', async () => {
        const captured: InternalAxiosRequestConfig[] = [];
        const path = '/openapi/v1/msp/{mspId}/sites';
        axios.defaults.adapter = ((config) => {
            captured.push(config);
            if (config.url?.startsWith('/v3/api-docs'))
                return respond(config, {
                    openapi: '3.1.0',
                    paths: { [path]: { get: { operationId: 'mspSites' } } },
                });
            if (config.url === '/openapi/authorize/token')
                return respond(config, {
                    errorCode: 0,
                    result: { accessToken: 'fixture-token', expiresIn: 3600 },
                });
            return respond(config, { errorCode: 0, result: [] });
        }) as AxiosAdapter;
        const client = await protocol(
            loadConfigFromEnv({ ...env, OMADA_MSP_ID: 'msp-scope', OMADA_AUTH_ID: 'oauth-principal', MCP_TOOL_CATEGORIES: 'msp:r' })
        );
        const search = await call(client, 'searchApiOperations', { query: 'msp sites', method: 'GET' });
        expect(search.isError).toBeFalsy();
        expect((await call(client, 'describeApiOperation', { operationId: 'mspSites' })).isError).toBeFalsy();
        expect((await call(client, 'executeApiOperation', { operationId: 'mspSites' })).isError).toBeFalsy();
        const authentication = captured.find((entry) => entry.url === '/openapi/authorize/token')!;
        expect(JSON.parse(String(authentication.data)).omadacId).toBe('oauth-principal');
        const request = captured.find((entry) => entry.url === '/openapi/v1/msp/msp-scope/sites')!;
        expect(request.headers.Authorization).toBe('AccessToken=fixture-token');
        expect(captured.filter((entry) => entry.url === request.url)).toHaveLength(1);
        expect((await call(client, 'executeApiOperation', { operationId: 'mspSites', params: { mspId: 'other-customer' } })).isError).toBe(true);
        expect(captured.filter((entry) => entry.url === request.url)).toHaveLength(1);
    });

    it('validates live OpenAPI 3.1 constraints over MCP before sending controller mutations', async () => {
        let writes = 0;
        axios.defaults.adapter = ((config) => {
            if (config.url?.startsWith('/v3/api-docs'))
                return respond(config, {
                    openapi: '3.1.0',
                    paths: {
                        '/openapi/v1/{omadacId}/settings': {
                            post: {
                                operationId: 'settings',
                                requestBody: {
                                    required: true,
                                    content: {
                                        'application/json': {
                                            schema: {
                                                type: 'object',
                                                properties: { values: { type: 'array', prefixItems: [{ type: 'integer' }], items: false } },
                                                required: ['values'],
                                                unevaluatedProperties: false,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                });
            if (config.url === '/openapi/authorize/token')
                return respond(config, { errorCode: 0, result: { accessToken: 'fixture-token', expiresIn: 3600 } });
            writes++;
            return respond(config, { errorCode: 0, result: {} });
        }) as AxiosAdapter;
        const client = await protocol(loadConfigFromEnv(env));
        const bad = await call(client, 'executeApiOperation', { operationId: 'settings', body: { values: [1, 2] }, dryRun: false });
        expect(bad.isError).toBe(true);
        expect(writes).toBe(0);
        const preview = await call(client, 'executeApiOperation', { operationId: 'settings', body: { values: [1] } });
        expect(preview.isError).toBeFalsy();
        expect(writes).toBe(0);
        expect((await call(client, 'executeApiOperation', { operationId: 'settings', body: { values: [1] }, dryRun: false })).isError).toBeFalsy();
        expect(writes).toBe(1);
    });

    it.each([
        { message: 'session expired', code: -900001, logins: 2, reads: 2, success: true },
        { message: 'permission denied', code: -900002, logins: 1, reads: 1, success: false },
        { message: 'login required', code: -900003, logins: 1, reads: 1, success: false },
    ])('bounds web-session renewal for $message without guessing unknown controller codes', async ({ message, code, logins, reads, success }) => {
        let loginCount = 0;
        let readCount = 0;
        axios.defaults.adapter = ((config) => {
            if (config.url === '/controller-scope/api/v2/login') {
                loginCount++;
                return respond(
                    config,
                    { errorCode: 0, result: { token: `csrf-${loginCount}` } },
                    { 'set-cookie': [`session=fixture-${loginCount}; HttpOnly`] }
                );
            }
            readCount++;
            return respond(
                config,
                readCount === 1
                    ? { errorCode: code, msg: message }
                    : { errorCode: 0, result: { data: [], totalRows: 0, currentPage: 1, currentSize: 0 } }
            );
        }) as AxiosAdapter;
        const client = await protocol(
            loadConfigFromEnv({ ...env, OMADA_AUTH_MODE: 'web', OMADA_WEB_USERNAME: 'fixture-user', OMADA_WEB_PASSWORD: 'fixture-password' })
        );
        const result = await call(client, 'listSites', {});
        expect(!result.isError).toBe(success);
        expect(loginCount).toBe(logins);
        expect(readCount).toBe(reads);
    });
});
