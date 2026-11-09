import type { AxiosInstance } from 'axios';
import type { EnvironmentConfig } from '../config.js';
import type { OperationCatalog } from '../discovery/catalog.js';
import { executeDiscoveredOperation } from '../discovery/execute.js';
import { CatalogLoader, documentationPath } from '../discovery/load.js';
import { ToolAccessPolicy } from '../server/toolPolicy.js';
import type { RequestHandler } from './request.js';

export interface DiscoveryPolicy {
    readOnly?: boolean;
    accessPolicy?: ToolAccessPolicy;
}
export interface SearchApiOperationsOptions {
    query?: string;
    tag?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    limit?: number;
}
export interface ExecuteApiOperationOptions {
    operationId: string;
    params?: Record<string, unknown>;
    body?: unknown;
    dryRun?: boolean;
    files?: Record<string, string | string[]>;
    downloadFile?: string;
}

/** Discovery stays lazy so existing tools and offline stdio initialization retain their behavior. */
export class DiscoveryOperations {
    private readonly loader: CatalogLoader;
    constructor(
        private readonly request: RequestHandler,
        http: AxiosInstance,
        private readonly config: Pick<
            EnvironmentConfig,
            | 'omadacId'
            | 'mspId'
            | 'siteId'
            | 'toolProfile'
            | 'toolCategories'
            | 'apiSpec'
            | 'requestTimeout'
            | 'transferDirectory'
            | 'maxTransferBytes'
        >,
        loader?: CatalogLoader
    ) {
        this.loader =
            loader ??
            new CatalogLoader(async (path) => {
                const response = await http.get<unknown>(documentationPath(path), {
                    // Same controller/TLS agent, no redirects or external references. No token is sent to documentation endpoints.
                    maxRedirects: 0,
                    maxContentLength: 16 * 1024 * 1024,
                    timeout: Math.min(config.requestTimeout ?? 10_000, 10_000),
                });
                return response.data;
            }, config.apiSpec ?? 'auto');
    }

    private readOnly(policy: DiscoveryPolicy): boolean {
        return this.config.toolProfile === 'read-only' || policy.readOnly === true || policy.accessPolicy?.readOnly === true;
    }

    private accessPolicy(policy: DiscoveryPolicy): ToolAccessPolicy {
        const configured = new ToolAccessPolicy(this.config.toolProfile, this.config.toolCategories);
        return configured.intersect(policy.accessPolicy ?? new ToolAccessPolicy(policy.readOnly ? 'read-only' : 'full'));
    }

    /** Share provenance and structural eligibility without fetching a second specification. */
    public async getCatalog(): Promise<OperationCatalog> {
        return await this.loader.get();
    }

    public async searchApiOperations(options: SearchApiOperationsOptions = {}, policy: DiscoveryPolicy = {}): Promise<unknown> {
        if (this.readOnly(policy) && options.method && options.method !== 'GET') throw new Error('Read-only discovery only exposes GET operations');
        const access = this.accessPolicy(policy);
        return (await this.loader.get()).search({
            ...options,
            readOnly: this.readOnly(policy),
            allowsOperation: (operation) => access.allowsOperation(operation.method, operation.path),
        });
    }

    public async describeApiOperation(operationId: string, policy: DiscoveryPolicy = {}): Promise<unknown> {
        const catalog = await this.loader.get();
        const operation = catalog.get(operationId);
        if (operation && !this.accessPolicy(policy).allowsOperation(operation.method, operation.path)) {
            if (this.readOnly(policy) && operation.method !== 'GET') throw new Error('The read-only profile does not expose write operations');
            throw new Error('Unknown or inaccessible API operation.');
        }
        return catalog.describe(operationId, { readOnly: this.readOnly(policy) });
    }

    public async executeApiOperation(options: ExecuteApiOperationOptions, policy: DiscoveryPolicy = {}): Promise<unknown> {
        const catalogue: OperationCatalog = await this.loader.get();
        return await executeDiscoveredOperation(catalogue, this.request, options, {
            omadacId: this.config.omadacId,
            mspId: this.config.mspId,
            transferDirectory: this.config.transferDirectory,
            maxTransferBytes: this.config.maxTransferBytes,
            siteId: this.config.siteId,
            readOnly: this.readOnly(policy),
            accessPolicy: this.accessPolicy(policy),
        });
    }
}
