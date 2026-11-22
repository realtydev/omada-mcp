import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfigFromEnv } from '../../src/config.js';
import { createSharedOmadaSession, OmadaClient } from '../../src/omadaClient/index.js';
import { MspCustomerRouter } from '../../src/omadaClient/mspCustomers.js';
import { createServer } from '../../src/server/common.js';

/**
 * Fake Omada controller in MSP mode. It follows a probe against a real controller
 * (v5.15.24.19, mspMode=true): logins and OpenAPI tokens only work with the MSP ID
 * (-1 / -44106 otherwise), the MSP ID is rejected as a data scope (-1005), and customer
 * data is served for the customer ID with the MSP token.
 */
const MSP = 'msp-1';
const customers = [
    { customerId: 'cust-a', customerName: 'Alpha Corp', sites: [{ siteId: 'site-a1', name: 'Thuis' }] },
    {
        customerId: 'cust-b',
        customerName: 'Beta Ltd',
        sites: [
            { siteId: 'site-b1', name: 'Thuis' },
            { siteId: 'site-b2', name: 'Branch' },
        ],
    },
];

const defaults = axios.defaults.adapter;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
    axios.defaults.adapter = defaults;
    await Promise.all(closers.splice(0).map((close) => close()));
});

function envelope(config: InternalAxiosRequestConfig, data: unknown, status = 200) {
    return Promise.resolve({ config, data, headers: { 'set-cookie': ['TPOMADA_SESSIONID=session-1; Path=/; HttpOnly'] }, status, statusText: 'OK' });
}
function page(config: InternalAxiosRequestConfig, rows: unknown[]) {
    return envelope(config, {
        errorCode: 0,
        msg: 'Success.',
        result: { totalRows: rows.length, currentPage: 1, currentSize: rows.length, data: rows },
    });
}

function fakeMspController() {
    const requests: InternalAxiosRequestConfig[] = [];
    let tokens = 0;
    axios.defaults.adapter = ((config) => {
        requests.push(config);
        const url = config.url ?? '';
        if (url === '/openapi/authorize/token') {
            const body = JSON.parse(String(config.data)) as { omadacId?: string };
            if (body.omadacId !== MSP) return envelope(config, { errorCode: -44106, msg: 'The Client Id Or Client Secret is Invalid.' });
            tokens += 1;
            return envelope(config, { errorCode: 0, result: { accessToken: `token-${tokens}`, refreshToken: 'refresh', expiresIn: 7200 } });
        }
        const login = /^\/([^/]+)\/api\/v2\/login$/.exec(url);
        if (login) {
            if (login[1] !== MSP) return envelope(config, { errorCode: -1, msg: 'General error.' });
            return envelope(config, { errorCode: 0, result: { token: 'csrf-1' } });
        }
        if (!String(config.headers?.Authorization ?? '').startsWith('AccessToken=')) {
            return envelope(config, { errorCode: -44116, msg: 'Unauthorized.' });
        }
        if (url === `/openapi/v1/msp/${MSP}/customers`) {
            return page(
                config,
                customers.map(({ customerId, customerName }) => ({ customerId, customerName }))
            );
        }
        const scoped = /^\/openapi\/v1\/([^/]+)\/(.*)$/.exec(url);
        const customer = customers.find((entry) => entry.customerId === scoped?.[1]);
        if (!scoped || !customer) return envelope(config, { errorCode: -1005, msg: 'Operation forbidden.' });
        if (scoped[2] === 'sites') return page(config, customer.sites);
        const site = /^sites\/([^/]+)\/devices$/.exec(scoped[2]);
        if (site && customer.sites.some((entry) => entry.siteId === site[1])) {
            return page(config, [{ mac: `AA-BB-CC-00-00-0${customer.sites.length}`, name: `${customer.customerName} AP`, type: 'ap' }]);
        }
        return envelope(config, { errorCode: -1005, msg: 'Operation forbidden.' });
    }) as AxiosAdapter;
    return {
        requests,
        tokenCount: () => tokens,
        dataPaths: () =>
            requests.map((entry) => entry.url ?? '').filter((url) => url.startsWith('/openapi/v1/') && !url.startsWith('/openapi/v1/msp/')),
    };
}

const baseEnv = {
    OMADA_BASE_URL: 'https://controller.example.test',
    OMADA_CLIENT_ID: 'msp-client',
    OMADA_CLIENT_SECRET: 'msp-secret',
    OMADA_MSP_ID: MSP,
    OMADA_AUTH_ID: MSP,
    OMADA_OMADAC_ID: 'cust-a',
    OMADA_API_SPEC: 'bundled',
};

async function connect(env: Record<string, string>) {
    const router = new MspCustomerRouter(loadConfigFromEnv({ ...baseEnv, ...env }));
    const server = createServer(router.client);
    const client = new Client({ name: 'msp-fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    closers.push(
        () => client.close(),
        () => server.close()
    );
    await Promise.all([client.connect(a), server.connect(b)]);
    return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    return { isError: result.isError === true, text, json: result.isError ? undefined : (JSON.parse(text) as unknown) };
}

describe('MSP customer routing', () => {
    it('authenticates with the MSP ID and sends data requests to the selected customer', async () => {
        const fake = fakeMspController();
        const client = await connect({});

        const listing = await callJson(client, 'listMspCustomers');
        expect(listing.json).toMatchObject({
            mspId: MSP,
            defaultCustomerId: 'cust-a',
            restricted: false,
            customers: [
                { customerId: 'cust-a', customerName: 'Alpha Corp', isDefault: true },
                { customerId: 'cust-b', customerName: 'Beta Ltd', isDefault: false },
            ],
        });

        const sites = await callJson(client, 'listSites', { customerId: 'beta ltd' });
        expect(sites.json).toEqual(customers[1].sites);
        const defaultSites = await callJson(client, 'listSites');
        expect(defaultSites.json).toEqual(customers[0].sites);

        expect(fake.dataPaths()).toEqual(expect.arrayContaining(['/openapi/v1/cust-b/sites', '/openapi/v1/cust-a/sites']));
        expect(fake.dataPaths().some((url) => url.includes(`/${MSP}/`))).toBe(false);
        const tokenRequests = fake.requests.filter((entry) => entry.url === '/openapi/authorize/token');
        expect(tokenRequests.every((entry) => JSON.parse(String(entry.data)).omadacId === MSP)).toBe(true);
        expect(fake.tokenCount()).toBe(1);
    });

    it('adds customerId to customer-scoped tools only', async () => {
        fakeMspController();
        const client = await connect({});
        const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
        const properties = (name: string) => Object.keys((tools.get(name)?.inputSchema as { properties?: object } | undefined)?.properties ?? {});
        expect(properties('listSites')).toContain('customerId');
        expect(properties('listDevices')).toContain('customerId');
        expect(properties('getServerInfo')).not.toContain('customerId');
        expect(properties('listMspCustomers')).not.toContain('customerId');
    });

    it('uses the only site of a non-default customer and keeps concurrent calls apart', async () => {
        const fake = fakeMspController();
        const client = await connect({ OMADA_OMADAC_ID: 'cust-b', OMADA_SITE_ID: 'site-b2' });

        const [alpha, beta] = await Promise.all([callJson(client, 'listDevices', { customerId: 'cust-a' }), callJson(client, 'listDevices', {})]);
        expect(alpha.json).toEqual([expect.objectContaining({ name: 'Alpha Corp AP' })]);
        expect(beta.json).toEqual([expect.objectContaining({ name: 'Beta Ltd AP' })]);
        expect(fake.dataPaths()).toEqual(
            expect.arrayContaining(['/openapi/v1/cust-a/sites/site-a1/devices', '/openapi/v1/cust-b/sites/site-b2/devices'])
        );
    });

    it('requires a customer when OMADA_OMADAC_ID is the MSP ID', async () => {
        const fake = fakeMspController();
        const client = await connect({ OMADA_OMADAC_ID: MSP });

        const missing = await callJson(client, 'listSites');
        expect(missing.isError).toBe(true);
        expect(missing.text).toContain('no default customer');
        expect(fake.dataPaths()).toEqual([]);

        expect((await callJson(client, 'listSites', { customerId: 'cust-a' })).json).toEqual(customers[0].sites);
        expect((await callJson(client, 'listMspCustomers')).json).toMatchObject({ defaultCustomerId: null });
    });

    it('refuses unknown and non-permitted customers before any data request', async () => {
        const fake = fakeMspController();
        const client = await connect({ OMADA_MSP_CUSTOMERS: 'Alpha Corp' });

        const blocked = await callJson(client, 'listSites', { customerId: 'cust-b' });
        expect(blocked.isError).toBe(true);
        expect(blocked.text).toContain('not permitted');
        const unknown = await callJson(client, 'listSites', { customerId: 'nobody' });
        expect(unknown.isError).toBe(true);
        expect(fake.dataPaths()).toEqual([]);

        const listing = await callJson(client, 'listMspCustomers');
        expect(listing.json).toMatchObject({ restricted: true, customers: [{ customerId: 'cust-a' }] });
    });
});

describe('MSP login principal', () => {
    it('logs in to the internal web API with OMADA_AUTH_ID while data keeps the customer ID', async () => {
        const fake = fakeMspController();
        const config = loadConfigFromEnv({ ...baseEnv, OMADA_WEB_USERNAME: 'viewer', OMADA_WEB_PASSWORD: 'secret' });
        const session = createSharedOmadaSession(config);
        await expect(session.internalAuth?.getAuthHeaders()).resolves.toMatchObject({ 'Csrf-Token': 'csrf-1' });
        expect(fake.requests.map((entry) => entry.url)).toContain(`/${MSP}/api/v2/login`);
    });

    it('keeps logging in with the controller ID when OMADA_AUTH_ID is not set', async () => {
        const requests: string[] = [];
        axios.defaults.adapter = ((config) => {
            requests.push(config.url ?? '');
            return envelope(config, { errorCode: 0, result: { token: 'csrf-2' } });
        }) as AxiosAdapter;
        const config = loadConfigFromEnv({
            OMADA_BASE_URL: 'https://controller.example.test',
            OMADA_OMADAC_ID: 'controller-1',
            OMADA_AUTH_MODE: 'web',
            OMADA_WEB_USERNAME: 'admin',
            OMADA_WEB_PASSWORD: 'secret',
        });
        const client = new OmadaClient(config);
        expect(client).toBeDefined();
        await createSharedOmadaSession(config).auth.getAuthHeaders();
        expect(requests).toEqual(['/controller-1/api/v2/login']);
    });

    it('rejects a token for a customer-level principal like the real controller (-44106)', async () => {
        fakeMspController();
        const config = loadConfigFromEnv({ ...baseEnv, OMADA_AUTH_ID: 'cust-a' });
        await expect(createSharedOmadaSession(config).auth.getAuthHeaders()).rejects.toThrow(/Client Id Or Client Secret is Invalid/);
    });
});

describe('OMADA_MSP_CUSTOMERS parsing', () => {
    it('treats empty and "all" as unrestricted and splits names or IDs', () => {
        const parse = (value?: string) =>
            loadConfigFromEnv({ ...baseEnv, ...(value === undefined ? {} : { OMADA_MSP_CUSTOMERS: value }) }).mspCustomers;
        expect(parse()).toBeUndefined();
        expect(parse('')).toBeUndefined();
        expect(parse('ALL')).toBeUndefined();
        expect(parse(' Alpha Corp , cust-b ,, ')).toEqual(['Alpha Corp', 'cust-b']);
    });
});
