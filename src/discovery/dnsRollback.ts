import type { DiscoveryOperations } from '../omadaClient/discovery.js';
import type { RequestHandler } from '../omadaClient/request.js';
import { type DnsChangeReceipt, dnsChangeReceiptSchema, sameDnsConfig } from '../utils/dns-change-schema.js';
import { executeLanDnsWrite, LAN_DNS_PATH, readLanDnsRows } from './lanDns.js';
import { executeMdnsWrite, MDNS_NETWORKS_PATH, MDNS_PATH, MDNS_PROFILES_PATH, readMdnsRows, validateMdnsReferences } from './mdns.js';

interface Row extends Record<string, unknown> {
    id: string;
}
const configuration = (row: Row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'));
const lower = (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : undefined);
const domainKey = (value: unknown) => (typeof value === 'string' ? value.toLowerCase().replace(/\.$/, '') : undefined);
function conflicts(row: Row, config: Record<string, unknown>, resource: DnsChangeReceipt['resource']) {
    return lower(row.name) === lower(config.name) || (resource === 'lan-dns' && domainKey(row.domain) === domainKey(config.domain));
}
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Restores only an unchanged applied snapshot; the verified CRUD helper rechecks that snapshot before its mutation. */
export class DnsRollbackOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly discovery: Pick<DiscoveryOperations, 'getCatalog' | 'executeApiOperation'>,
        private readonly controllerId: string
    ) {}
    async rollbackDnsChange(receipt: DnsChangeReceipt, dryRun = true): Promise<unknown> {
        const parsed = dnsChangeReceiptSchema.parse(receipt);
        if (parsed.controllerId !== this.controllerId) throw new Error('Rollback receipt belongs to a different controller');
        if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean');
        const lan = parsed.resource === 'lan-dns',
            path = lan ? LAN_DNS_PATH : MDNS_PATH,
            idName = lan ? 'dnsId' : 'mdnsId';
        const catalog = await this.discovery.getCatalog();
        const list = catalog.operations.find((op) => op.method === 'GET' && op.path === path && !op.unsupportedReason);
        if (!list) throw new Error('DNS rollback requires a supported list operation in the catalog');
        const readPage = async (page: number) => {
            const result = await this.discovery.executeApiOperation({
                operationId: list.operationId,
                params: { siteId: parsed.siteId, page, pageSize: 100 },
            });
            if (!object(result) || !Object.hasOwn(result, 'result')) throw new Error('DNS rollback could not read current configuration');
            return result.result;
        };
        const rows: Row[] = await (lan ? readLanDnsRows : readMdnsRows)(readPage);
        const noop = () => ({
            operation: 'rollback',
            resource: parsed.resource,
            dryRun,
            written: false,
            verified: true,
            changes: [],
            verification: { status: 'verified', attempts: 0 },
        });
        let method: 'POST' | 'PATCH' | 'DELETE', id: string | undefined;
        const expected = parsed.applied !== null ? { id: parsed.appliedId!, config: parsed.applied } : undefined;
        if (parsed.applied === null) {
            const matching = rows.filter((row) => conflicts(row, parsed.before!, parsed.resource));
            if (matching.length === 1 && sameDnsConfig(configuration(matching[0]), parsed.before)) return noop();
            if (matching.length || rows.some((row) => row.id === parsed.beforeId))
                throw new Error('Rollback refused: DNS configuration was replaced or conflicts with the original');
            method = 'POST';
        } else {
            const current = rows.find((row) => row.id === parsed.appliedId);
            if (parsed.before === null && !current && !rows.some((row) => conflicts(row, parsed.applied!, parsed.resource))) return noop();
            if (parsed.before !== null && current?.id === parsed.beforeId && sameDnsConfig(configuration(current), parsed.before)) return noop();
            if (!current || !sameDnsConfig(configuration(current), parsed.applied))
                throw new Error('Rollback refused: DNS configuration changed or was replaced after this receipt');
            method = parsed.before === null ? 'DELETE' : 'PATCH';
            id = current.id;
        }
        const operation = catalog.operations.find(
            (op) => op.method === method && op.path === (method === 'POST' ? path : `${path}/{${idName}}`) && !op.unsupportedReason
        );
        if (!operation) throw new Error('DNS rollback requires a supported restoration operation in the catalog');
        const body = method === 'DELETE' ? undefined : parsed.before!;
        const preview = await this.discovery.executeApiOperation({
            operationId: operation.operationId,
            params: { siteId: parsed.siteId, ...(id ? { [idName]: id } : {}) },
            ...(body ? { body } : {}),
            dryRun: true,
        });
        const readReference = async (referencePath: string, page?: number) => {
            const source = catalog.operations.find((op) => op.method === 'GET' && op.path === referencePath && !op.unsupportedReason);
            if (!source) throw new Error('DNS rollback requires supported reference operations in the catalog');
            const result = await this.discovery.executeApiOperation({
                operationId: source.operationId,
                params: { siteId: parsed.siteId, ...(page === undefined ? {} : { page, pageSize: 100 }) },
            });
            if (!object(result) || !Object.hasOwn(result, 'result')) throw new Error('DNS rollback could not read reference configuration');
            return result.result;
        };
        const validateReferences = (desired: Record<string, unknown>) =>
            validateMdnsReferences(
                desired,
                () => readReference(MDNS_PROFILES_PATH),
                (page) => readReference(MDNS_NETWORKS_PATH, page)
            );
        if (!lan && body) await validateReferences(body);
        if (dryRun)
            return {
                operation: 'rollback',
                resource: parsed.resource,
                dryRun: true,
                written: false,
                verified: false,
                changes: [{ before: parsed.applied, after: parsed.before }],
                preview,
            };
        const url = (method === 'POST' ? path : `${path}/{${idName}}`)
            .replace('{omadacId}', encodeURIComponent(this.controllerId))
            .replace('{siteId}', encodeURIComponent(parsed.siteId))
            .replace(`{${idName}}`, encodeURIComponent(id ?? ''));
        const validateBody = (desired: Record<string, unknown>) => {
            if (!sameDnsConfig(desired, body)) throw new Error('Rollback refused: restoration configuration changed during preflight');
        };
        const result = lan
            ? await executeLanDnsWrite(this.request, method, url, id, body, readPage, validateBody, { expected })
            : await executeMdnsWrite(this.request, method, url, id, body, readPage, validateBody, { expected }, validateReferences);
        return { operation: 'rollback', resource: parsed.resource, dryRun: false, ...result };
    }
}
