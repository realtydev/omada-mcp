import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from '../utils/logger.js';
import { createSharedOmadaSession, OmadaClient, type OmadaClientOptions, type SharedOmadaSession } from './index.js';
import { RequestHandler } from './request.js';

/** One customer of an Omada MSP, as listed by /openapi/v1/msp/{mspId}/customers. */
export interface MspCustomer {
    customerId: string;
    customerName: string;
    [key: string]: unknown;
}

export interface MspCustomerListing {
    mspId: string;
    defaultCustomerId: string | null;
    restricted: boolean;
    customers: { customerId: string; customerName: string; isDefault: boolean }[];
}

/**
 * Per-call customer selection for MSP controllers. Tool registration wraps every
 * customer-scoped tool so that an optional `customerId` argument (ID or name) picks the
 * customer whose ID goes into request paths, while authentication stays on the MSP ID.
 */
export interface MspCustomerScope {
    readonly mspId: string;
    readonly defaultCustomerId?: string;
    /** Run fn with the given customer selected. Throws for unknown or non-permitted customers. */
    run<T>(customerRef: string | undefined, fn: () => Promise<T>, requireCustomer?: boolean): Promise<T>;
    listCustomers(): Promise<MspCustomerListing>;
}

const CUSTOMER_LIST_TTL_MS = 5 * 60_000;
const MAX_CUSTOMER_REF_LENGTH = 128;

/**
 * Routes OmadaClient calls to one client per MSP customer. All customer clients share a
 * single authentication session: one OAuth token and one web session issued for the MSP ID.
 */
export class MspCustomerRouter implements MspCustomerScope {
    public readonly mspId: string;
    public readonly defaultCustomerId?: string;
    /** OmadaClient-compatible proxy that forwards to the customer selected for the current call. */
    public readonly client: OmadaClient;

    private readonly context = new AsyncLocalStorage<{ customerId: string }>();
    private readonly request: RequestHandler;
    private readonly clients = new Map<string, OmadaClient>();
    private readonly pendingClients = new Map<string, Promise<OmadaClient>>();
    private readonly allowlist?: string[];
    private customers?: { loadedAt: number; list: MspCustomer[] };

    constructor(
        private readonly config: OmadaClientOptions,
        private readonly session: SharedOmadaSession = createSharedOmadaSession(config)
    ) {
        if (!config.mspId) throw new Error('MSP customer routing requires OMADA_MSP_ID.');
        this.mspId = config.mspId;
        this.allowlist = config.mspCustomers?.length ? config.mspCustomers : undefined;
        // OMADA_OMADAC_ID equal to the MSP ID means "no default customer": every customer-scoped
        // call must then name one, because the MSP ID is rejected (-1005) as a data scope.
        this.defaultCustomerId = config.omadacId === config.mspId ? undefined : config.omadacId;
        this.request = new RequestHandler(session.http, session.auth);

        const base = new OmadaClient(config, session);
        if (this.defaultCustomerId) this.clients.set(this.defaultCustomerId, base);
        this.client = new Proxy(base, {
            get: (target, property) => {
                if (property === 'mspCustomerScope') return () => this as MspCustomerScope;
                const selected = this.context.getStore();
                const current = (selected && this.clients.get(selected.customerId)) || target;
                const value: unknown = Reflect.get(current, property, current);
                return typeof value === 'function' ? value.bind(current) : value;
            },
        });
    }

    public async run<T>(customerRef: string | undefined, fn: () => Promise<T>, requireCustomer = true): Promise<T> {
        const customerId = await this.resolveCustomerId(customerRef, requireCustomer);
        if (customerId === undefined) return await fn();
        await this.clientFor(customerId);
        return await this.context.run({ customerId }, fn);
    }

    public async listCustomers(): Promise<MspCustomerListing> {
        const customers = await this.allowedCustomers(true);
        return {
            mspId: this.mspId,
            defaultCustomerId: this.defaultCustomerId ?? null,
            restricted: this.allowlist !== undefined,
            customers: customers.map((customer) => ({
                customerId: customer.customerId,
                customerName: customer.customerName,
                isDefault: customer.customerId === this.defaultCustomerId,
            })),
        };
    }

    private async resolveCustomerId(customerRef: string | undefined, requireCustomer: boolean): Promise<string | undefined> {
        const ref = customerRef?.trim();
        if (!ref) {
            if (this.defaultCustomerId) return this.defaultCustomerId;
            if (!requireCustomer) return undefined;
            throw new Error('This MSP server has no default customer. Pass customerId (an ID or name from listMspCustomers).');
        }
        if (ref.length > MAX_CUSTOMER_REF_LENGTH) throw new Error('customerId is too long.');
        if (ref === this.defaultCustomerId) return ref;
        for (const force of [false, true]) {
            const customers = await this.allowedCustomers(force);
            const byId = customers.find((customer) => customer.customerId === ref);
            if (byId) return byId.customerId;
            const byName = customers.filter((customer) => customer.customerName.toLowerCase() === ref.toLowerCase());
            if (byName.length === 1) return byName[0].customerId;
            if (byName.length > 1) throw new Error(`Customer name "${ref}" is ambiguous; pass the customer ID from listMspCustomers.`);
        }
        throw new Error(`Unknown or not permitted MSP customer "${ref}". Use listMspCustomers to see the available customers.`);
    }

    /** Customers visible to the MSP credentials, filtered by OMADA_MSP_CUSTOMERS. */
    private async allowedCustomers(force: boolean): Promise<MspCustomer[]> {
        if (force || !this.customers || Date.now() - this.customers.loadedAt > CUSTOMER_LIST_TTL_MS) {
            const list = await this.request.fetchPaginated<MspCustomer>(`/openapi/v1/msp/${encodeURIComponent(this.mspId)}/customers`, {}, 100);
            this.customers = {
                loadedAt: Date.now(),
                list: list.filter((customer) => typeof customer.customerId === 'string' && typeof customer.customerName === 'string'),
            };
        }
        const allowlist = this.allowlist?.map((entry) => entry.toLowerCase());
        if (!allowlist) return this.customers.list;
        return this.customers.list.filter(
            (customer) =>
                customer.customerId === this.defaultCustomerId ||
                allowlist.includes(customer.customerId.toLowerCase()) ||
                allowlist.includes(customer.customerName.toLowerCase())
        );
    }

    /**
     * Create (once) the client for a customer. OMADA_SITE_ID only applies to the configured
     * default customer; another customer with exactly one site gets that site as its default.
     */
    private async clientFor(customerId: string): Promise<OmadaClient> {
        const existing = this.clients.get(customerId);
        if (existing) return existing;
        let pending = this.pendingClients.get(customerId);
        if (!pending) {
            pending = this.createCustomerClient(customerId).finally(() => this.pendingClients.delete(customerId));
            this.pendingClients.set(customerId, pending);
        }
        return await pending;
    }

    private async createCustomerClient(customerId: string): Promise<OmadaClient> {
        let siteId: string | undefined;
        try {
            const sites = await this.request.fetchPaginated<{ siteId: string }>(`/openapi/v1/${encodeURIComponent(customerId)}/sites`, {}, 100);
            if (sites.length === 1 && typeof sites[0].siteId === 'string') siteId = sites[0].siteId;
        } catch (error) {
            logger.warn('Could not list MSP customer sites; tools will need an explicit siteId', {
                customerId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        const client = new OmadaClient({ ...this.config, omadacId: customerId, siteId }, this.session);
        this.clients.set(customerId, client);
        return client;
    }
}

/** Return the MSP customer scope of a client created by MspCustomerRouter, if any. */
export function mspCustomerScopeOf(client: unknown): MspCustomerScope | undefined {
    const scoped = client as { mspCustomerScope?: () => MspCustomerScope } | undefined;
    return typeof scoped?.mspCustomerScope === 'function' ? scoped.mspCustomerScope() : undefined;
}
