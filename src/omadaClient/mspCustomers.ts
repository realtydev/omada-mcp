import { AsyncLocalStorage } from 'node:async_hooks';

import type { ApiOperation } from '../discovery/catalog.js';
import type { DiscoveryTarget } from '../discovery/execute.js';
import { categoryForPath } from '../server/toolPolicy.js';
import { logger } from '../utils/logger.js';
import { createDiscoveryCatalog, type ExecuteApiOperationOptions } from './discovery.js';
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
    run<T>(customerRef: string | undefined, fn: () => Promise<T>, inferSite: boolean): Promise<T>;
    listCustomers(): Promise<MspCustomerListing>;
    resolveDiscoveryTarget(operation: ApiOperation, options: ExecuteApiOperationOptions): Promise<DiscoveryTarget>;
}

const CUSTOMER_LIST_TTL_MS = 5 * 60_000;
const MAX_CUSTOMER_REF_LENGTH = 128;
export const MISSING_MSP_CUSTOMER = 'This MSP server has no default customer. Pass customerId (an ID or name from listMspCustomers).';

/**
 * Routes OmadaClient calls to one client per MSP customer. All customer clients share a
 * single authentication session: one OAuth token and one web session issued for the MSP ID.
 */
export class MspCustomerRouter implements MspCustomerScope {
    public readonly mspId: string;
    public readonly defaultCustomerId?: string;
    /** OmadaClient-compatible proxy that forwards to the customer selected for the current call. */
    public readonly client: OmadaClient;

    private readonly context = new AsyncLocalStorage<OmadaClient>();
    private readonly session: SharedOmadaSession;
    private readonly request: RequestHandler;
    private readonly clients = new Map<string, { siteId?: string; client: OmadaClient }>();
    private readonly pendingSiteLookups = new Map<string, Promise<string | undefined>>();
    private readonly allowlist?: Set<string>;
    private customers?: { loadedAt: number; list: MspCustomer[] };
    private pendingCustomers?: Promise<MspCustomer[]>;

    constructor(
        private readonly config: OmadaClientOptions,
        session: SharedOmadaSession = createSharedOmadaSession(config)
    ) {
        if (!config.mspId) throw new Error('MSP customer routing requires OMADA_MSP_ID.');
        this.mspId = config.mspId;
        this.allowlist = config.mspCustomers?.length ? new Set(config.mspCustomers.map((entry) => entry.toLowerCase())) : undefined;
        // OMADA_OMADAC_ID equal to the MSP ID means "no default customer": every customer-scoped
        // call must then name one, because the MSP ID is rejected (-1005) as a data scope.
        this.defaultCustomerId = config.omadacId === config.mspId ? undefined : config.omadacId;
        this.session = { ...session, catalog: session.catalog ?? createDiscoveryCatalog(session.http, config), msp: this };
        this.request = new RequestHandler(session.http, session.auth);

        const base = new OmadaClient(config, this.session);
        if (this.defaultCustomerId) this.clients.set(this.defaultCustomerId, { siteId: config.siteId, client: base });
        this.client = new Proxy(base, {
            get: (target, property) => {
                if (property === 'mspCustomerScope') return () => this as MspCustomerScope;
                const current = this.context.getStore() ?? target;
                const value: unknown = Reflect.get(current, property, current);
                return typeof value === 'function' ? value.bind(current) : value;
            },
        });
    }

    public async run<T>(customerRef: string | undefined, fn: () => Promise<T>, inferSite: boolean): Promise<T> {
        const customerId = await this.resolveCustomerId(customerRef);
        const siteId = inferSite ? await this.siteFor(customerId, true) : undefined;
        const existing = this.clients.get(customerId);
        if (existing && (!inferSite || existing.siteId === siteId)) return await this.context.run(existing.client, fn);
        const client = new OmadaClient({ ...this.config, omadacId: customerId, siteId }, this.session);
        this.clients.set(customerId, { siteId, client });
        return await this.context.run(client, fn);
    }

    public async listCustomers(): Promise<MspCustomerListing> {
        const customers = await this.readCustomers(true);
        return {
            mspId: this.mspId,
            defaultCustomerId: this.defaultCustomerId ?? null,
            restricted: this.allowlist !== undefined,
            customers: customers
                .filter((customer) => this.isAllowed(customer, customers))
                .map((customer) => ({
                    customerId: customer.customerId,
                    customerName: customer.customerName,
                    isDefault: customer.customerId === this.defaultCustomerId,
                })),
        };
    }

    public async resolveDiscoveryTarget(operation: ApiOperation, options: ExecuteApiOperationOptions): Promise<DiscoveryTarget> {
        const msp = categoryForPath(operation.path) === 'msp';
        const hasCustomerPath =
            operation.path.split('/').includes('{customerId}') &&
            operation.parameters.some((parameter) => parameter.in === 'path' && parameter.name === 'customerId');
        const customerPath = msp && hasCustomerPath;
        // A restricted server has no grant to act on the MSP account as a whole.
        if (
            msp &&
            this.allowlist &&
            (!customerPath ||
                !/^\/openapi\/v[12]\/msp\/\{mspId\}\/customers\/\{customerId\}(?:\/|$)/.test(operation.path) ||
                operation.method !== 'GET')
        ) {
            throw new Error('The MSP customer allowlist permits only customer-scoped MSP reads. Use listMspCustomers to list permitted customers.');
        }
        if (msp && !customerPath) {
            if (options.customerId !== undefined) throw new Error('This MSP-wide operation does not take customerId.');
            return {};
        }
        const parameterCustomerId = customerPath ? options.params?.customerId : undefined;
        if (parameterCustomerId !== undefined && typeof parameterCustomerId !== 'string') {
            throw new Error('The operation customerId must be a customer ID.');
        }
        const customerId = await this.resolveCustomerId(options.customerId ?? parameterCustomerId);
        if (parameterCustomerId !== undefined && parameterCustomerId !== customerId) {
            throw new Error('The operation customerId must match the selected MSP customer.');
        }
        const inferSite = options.params?.siteId === undefined && operation.parameters.some((parameter) => parameter.name === 'siteId');
        return {
            omadacId: customerId,
            siteId: await this.siteFor(customerId, inferSite),
            ...(customerPath ? { customerId } : {}),
        };
    }

    private async resolveCustomerId(customerRef: string | undefined): Promise<string> {
        const ref = customerRef?.trim();
        if (!ref) {
            if (this.defaultCustomerId) return this.defaultCustomerId;
            throw new Error(MISSING_MSP_CUSTOMER);
        }
        if (ref.length > MAX_CUSTOMER_REF_LENGTH) throw new Error('customerId is too long.');
        if (ref === this.defaultCustomerId) return ref;
        const customers = await this.readCustomers();
        let selected = customers.find((customer) => customer.customerId === ref);
        if (!selected) {
            const matches = customers.filter((customer) => customer.customerName.toLowerCase() === ref.toLowerCase());
            if (matches.length > 1) throw new Error(`Customer name "${ref}" is ambiguous; pass the customer ID from listMspCustomers.`);
            selected = matches[0];
        }
        if (selected && this.isAllowed(selected, customers)) return selected.customerId;
        throw new Error(`Unknown or not permitted MSP customer "${ref}". Use listMspCustomers to see the available customers.`);
    }

    private isAllowed(customer: MspCustomer, customers: MspCustomer[]): boolean {
        if (!this.allowlist || customer.customerId === this.defaultCustomerId || this.allowlist.has(customer.customerId.toLowerCase())) {
            return true;
        }
        const name = customer.customerName.toLowerCase();
        return (
            this.allowlist.has(name) &&
            !customers.some((other) => other !== customer && (other.customerId.toLowerCase() === name || other.customerName.toLowerCase() === name))
        );
    }

    private async readCustomers(force = false): Promise<MspCustomer[]> {
        if (!force && this.customers && Date.now() - this.customers.loadedAt < CUSTOMER_LIST_TTL_MS) return this.customers.list;
        this.pendingCustomers ??= this.request
            .fetchPaginated<MspCustomer>(`/openapi/v1/msp/${encodeURIComponent(this.mspId)}/customers`, {}, 100)
            .then((rows) => {
                const list = rows.filter((customer) => typeof customer?.customerId === 'string' && typeof customer?.customerName === 'string');
                this.customers = { loadedAt: Date.now(), list };
                return list;
            })
            .finally(() => {
                this.pendingCustomers = undefined;
            });
        return await this.pendingCustomers;
    }

    private async siteFor(customerId: string, inferSite: boolean): Promise<string | undefined> {
        if (customerId === this.defaultCustomerId) return this.config.siteId;
        if (!inferSite) return undefined;
        // Coalesce concurrent lookups, but re-read on the next implicit-site call.
        let pending = this.pendingSiteLookups.get(customerId);
        if (!pending) {
            pending = this.inferSite(customerId).finally(() => this.pendingSiteLookups.delete(customerId));
            this.pendingSiteLookups.set(customerId, pending);
        }
        return await pending;
    }

    private async inferSite(customerId: string): Promise<string | undefined> {
        try {
            const sites = await this.request.fetchPaginated<{ siteId: string }>(`/openapi/v1/${encodeURIComponent(customerId)}/sites`, {}, 100);
            return sites.length === 1 && typeof sites[0]?.siteId === 'string' ? sites[0].siteId : undefined;
        } catch (error) {
            logger.warn('Could not list MSP customer sites; tools will need an explicit siteId', {
                customerId,
                error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
        }
    }
}

/** Return the MSP customer scope of a client created by MspCustomerRouter, if any. */
export function mspCustomerScopeOf(client: unknown): MspCustomerScope | undefined {
    const scoped = client as { mspCustomerScope?: () => MspCustomerScope } | undefined;
    return typeof scoped?.mspCustomerScope === 'function' ? scoped.mspCustomerScope() : undefined;
}
