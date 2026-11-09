import type { AxiosInstance } from 'axios';
import type { EnvironmentConfig } from '../config.js';
import type { OperationCatalog } from '../discovery/catalog.js';
import { executeDiscoveredOperation } from '../discovery/execute.js';
import { CatalogLoader, documentationPath } from '../discovery/load.js';
import type { RequestHandler } from './request.js';

export interface DiscoveryPolicy {
    readOnly?: boolean;
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
}

/** Discovery stays lazy so existing tools and offline stdio initialization retain their behavior. */
export class DiscoveryOperations {
    private readonly loader: CatalogLoader;
    constructor(
        private readonly request: RequestHandler,
        http: AxiosInstance,
        private readonly config: Pick<EnvironmentConfig, 'omadacId' | 'siteId' | 'toolProfile' | 'apiSpec' | 'requestTimeout'>,
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
        return this.config.toolProfile === 'read-only' || policy.readOnly === true;
    }

    public async searchApiOperations(options: SearchApiOperationsOptions = {}, policy: DiscoveryPolicy = {}): Promise<unknown> {
        if (this.readOnly(policy) && options.method && options.method !== 'GET') throw new Error('Read-only discovery only exposes GET operations');
        return (await this.loader.get()).search({ ...options, readOnly: this.readOnly(policy) });
    }

    public async describeApiOperation(operationId: string, policy: DiscoveryPolicy = {}): Promise<unknown> {
        return (await this.loader.get()).describe(operationId, { readOnly: this.readOnly(policy) });
    }

    public async executeApiOperation(options: ExecuteApiOperationOptions, policy: DiscoveryPolicy = {}): Promise<unknown> {
        const catalogue: OperationCatalog = await this.loader.get();
        return await executeDiscoveredOperation(catalogue, this.request, options, {
            omadacId: this.config.omadacId,
            siteId: this.config.siteId,
            readOnly: this.readOnly(policy),
        });
    }
}
