import type { AxiosInstance } from 'axios';

import type { EnvironmentConfig } from '../config.js';
import type { OperationCatalog } from '../discovery/catalog.js';
import { createRequestRedactor } from '../utils/redact.js';
import { completeSsidSchema } from '../utils/ssid-update-schema.js';
import type { DiscoveryOperations } from './discovery.js';
import { controllerRequest } from './transport.js';

type RecordValue = Record<string, unknown>;
type EvidenceStatus = 'ok' | 'forbidden' | 'unsupported' | 'unavailable' | 'unknown';
interface Failure {
    status: Exclude<EvidenceStatus, 'ok'>;
    reason: string;
    httpStatus?: number;
    errorCode?: number;
}
type CapabilityConfig = Pick<EnvironmentConfig, 'authMode' | 'webUsername' | 'webPassword' | 'siteId' | 'requestTimeout'>;

export interface GetControllerCapabilitiesOptions {
    siteId?: string;
    wlanId?: string;
    ssidId?: string;
}

export interface CapabilityEvidenceClient {
    getSsidDetail(wlanId: string, ssidId: string, siteId?: string): Promise<unknown>;
}

interface ControllerMetadata {
    status: 'ok';
    source: '/api/info';
    version?: string;
    apiVersion?: string;
    mode: 'classic' | 'msp' | 'unknown';
    configured?: boolean;
    mspRouting: 'not_applicable' | 'unsupported' | 'unknown';
    limitations: string[];
}

interface FeatureAdvertisement {
    feature: string;
    advertisement: 'live_documented' | 'bundled_documented' | 'not_documented';
    operations: number;
    structurallyExecutable: number;
    apiVersions: string[];
    controllerSupport: 'not_tested';
}

interface CatalogEvidence {
    status: 'ok';
    source: 'live' | 'bundled';
    loadedAt: number;
    fallback: boolean;
    openapiVersion: string;
    operations: { total: number; structurallyExecutable: number; unsupported: number; getOperations: number; nonGetOperations: number };
    unsupportedReasons: { reason: string; operations: number }[];
    features: FeatureAdvertisement[];
    limitations: string[];
}

interface SsidEvidence {
    status: 'ok';
    sampleOnly: true;
    missingRequiredFields: string[];
    invalidRequiredFields: string[];
    mloEnable: { availability: 'present'; value: boolean } | { availability: 'missing' | 'invalid' };
    securityKey: 'present' | 'hidden' | 'missing' | 'not_applicable' | 'unknown';
    limitations: string[];
}

export interface ControllerCapabilitiesResult {
    capturedAt: number;
    completedAt: number;
    configuration: {
        authenticationMode: 'oauth' | 'web';
        openApi: 'configured';
        internalWebApi: 'configured' | 'not_configured';
        siteSelected: boolean;
    };
    controller: ControllerMetadata | Failure;
    catalog: CatalogEvidence | Failure;
    ssidEvidence: SsidEvidence | Failure | { status: 'not_requested'; reason: string };
}

const MAX_METADATA_BYTES = 256 * 1024;
const object = (value: unknown): RecordValue | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;

function failure(value: unknown): Failure {
    const source = object(value);
    const response = object(source?.response);
    const body = object(response?.data);
    const httpStatus = typeof source?.status === 'number' ? source.status : typeof response?.status === 'number' ? response.status : undefined;
    const errorCode = typeof source?.errorCode === 'number' ? source.errorCode : typeof body?.errorCode === 'number' ? body.errorCode : undefined;
    const details = {
        ...(Number.isSafeInteger(httpStatus) ? { httpStatus } : {}),
        ...(Number.isSafeInteger(errorCode) ? { errorCode } : {}),
    };
    if (httpStatus === 401 || httpStatus === 403 || (errorCode !== undefined && [-44106, -44112, -44113].includes(errorCode)))
        return { status: 'forbidden', reason: 'Access to this evidence was denied.', ...details };
    if ((httpStatus !== undefined && [404, 405, 501].includes(httpStatus)) || errorCode === -1600)
        return { status: 'unsupported', reason: 'This evidence endpoint is not available on the controller.', ...details };
    if ((httpStatus !== undefined && httpStatus >= 500) || typeof source?.code === 'string')
        return { status: 'unavailable', reason: 'This evidence could not be collected.', ...details };
    return { status: 'unknown', reason: 'The controller did not provide usable evidence.', ...details };
}

function version(value: unknown): string | undefined {
    const result = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    return result.length <= 128 && /^(?:v)?\d[\w. +:()/-]*$/.test(result) ? result : undefined;
}

function unsupportedReason(reason: string): string {
    if (/controller-scoped/.test(reason)) return 'unsupported_path_scope';
    if (/reference|resolve|cyclic/i.test(reason)) return 'unresolved_schema_reference';
    if (/parameter|serialization|style/i.test(reason)) return 'unsupported_parameter_contract';
    if (/body|json|schema|binary|content/i.test(reason)) return 'unsupported_body_or_schema';
    if (/path|version|route/i.test(reason)) return 'unsupported_path_contract';
    return 'unsupported_operation_contract';
}

const FEATURES: Array<{ feature: string; path: RegExp }> = [
    { feature: 'siteListing', path: /\/sites$/ },
    { feature: 'clients', path: /\/sites\/\{[^}]+\}\/clients(?:\/|$)/ },
    { feature: 'switchPorts', path: /\/switches\/(?:\{[^}]+\}\/)?(?:ports|multi-ports)(?:\/|$)/ },
    { feature: 'wirelessSettings', path: /\/wireless-network\// },
    { feature: 'healthAndHistory', path: /\/health\/|\/client-timeline|\/journey|\/incidents?(?:\/|$)/i },
    { feature: 'radioDiagnostics', path: /rf[-/]?scan|available[-/]?channels?|full-channel|\/afc(?:\/|$)/i },
    { feature: 'vpnStatus', path: /\/setting\/vpn\/stats\// },
    { feature: 'mspSiteListing', path: /^\/openapi\/v[12]\/msp\/\{[^}]+\}\/sites$/ },
];

/** Collect bounded read evidence; schema advertisement never establishes hardware support. */
export class ControllerCapabilityOperations {
    constructor(
        private readonly http: AxiosInstance,
        private readonly discovery: Pick<DiscoveryOperations, 'getCatalog'>,
        private readonly config: CapabilityConfig,
        private readonly evidence?: CapabilityEvidenceClient
    ) {}

    public async getControllerCapabilities(options: GetControllerCapabilitiesOptions = {}): Promise<ControllerCapabilitiesResult> {
        for (const value of [options.siteId, options.wlanId, options.ssidId]) {
            if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 128))
                throw new Error('Capability identifiers must be non-empty strings of at most 128 characters.');
        }
        if ((options.wlanId === undefined) !== (options.ssidId === undefined)) throw new Error('Provide both wlanId and ssidId to inspect one SSID.');
        const capturedAt = Date.now();
        const siteId = options.siteId ?? this.config.siteId;
        const [controller, catalog, ssidEvidence] = await Promise.all([this.metadata(), this.catalog(), this.ssidEvidence(options, siteId)]);
        return {
            capturedAt,
            completedAt: Date.now(),
            configuration: {
                authenticationMode: this.config.authMode,
                openApi: 'configured',
                internalWebApi: this.config.webUsername && this.config.webPassword ? 'configured' : 'not_configured',
                siteSelected: siteId !== undefined,
            },
            controller,
            catalog,
            ssidEvidence,
        };
    }

    private async metadata(): Promise<ControllerMetadata | Failure> {
        try {
            const response = await controllerRequest<unknown>(this.http, {
                method: 'GET',
                url: '/api/info',
                maxRedirects: 0,
                maxContentLength: MAX_METADATA_BYTES,
                timeout: Math.min(this.config.requestTimeout ?? 10_000, 10_000),
            });
            if (Buffer.byteLength(JSON.stringify(response.data)) > MAX_METADATA_BYTES) return failure(undefined);
            const envelope = object(response.data);
            if (!envelope) return failure(undefined);
            if (envelope.errorCode !== undefined && envelope.errorCode !== 0) return failure(envelope);
            const data = envelope.errorCode === 0 ? object(envelope.result) : envelope;
            if (!data) return failure(undefined);
            const redact = createRequestRedactor(this.config);
            const controllerVersion = version(redact(data.controllerVer ?? data.controllerVersion ?? data.version));
            const apiVersion = version(redact(data.apiVer ?? data.apiVersion));
            const mode = data.mspMode === true ? 'msp' : data.mspMode === false ? 'classic' : 'unknown';
            if (!controllerVersion && !apiVersion && mode === 'unknown' && typeof data.configured !== 'boolean') return failure(undefined);
            return {
                status: 'ok',
                source: '/api/info',
                ...(controllerVersion ? { version: controllerVersion } : {}),
                ...(apiVersion ? { apiVersion } : {}),
                mode,
                ...(typeof data.configured === 'boolean' ? { configured: data.configured } : {}),
                mspRouting: mode === 'msp' ? 'unsupported' : mode === 'classic' ? 'not_applicable' : 'unknown',
                limitations: [
                    'Metadata API version does not establish support for the same Open API execution version.',
                    ...(mode === 'msp' ? ['MSP site routing is not implemented; classic routes are not automatically rewritten.'] : []),
                    ...(mode === 'unknown' ? ['Controller mode was not explicitly reported as a boolean mspMode.'] : []),
                ],
            };
        } catch (error) {
            return failure(error);
        }
    }

    private async catalog(): Promise<CatalogEvidence | Failure> {
        try {
            const catalog: OperationCatalog = await this.discovery.getCatalog();
            const unsupported = catalog.operations.filter((operation) => operation.unsupportedReason !== undefined);
            const reasons = new Map<string, number>();
            for (const operation of unsupported) {
                const reason = unsupportedReason(operation.unsupportedReason ?? '');
                reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
            }
            return {
                status: 'ok',
                source: catalog.source,
                loadedAt: catalog.loadedAt,
                fallback: catalog.fallbackReason !== undefined,
                openapiVersion: version(catalog.document.openapi) ?? 'unknown',
                operations: {
                    total: catalog.operations.length,
                    structurallyExecutable: catalog.operations.length - unsupported.length,
                    unsupported: unsupported.length,
                    getOperations: catalog.operations.filter((operation) => operation.method === 'GET').length,
                    nonGetOperations: catalog.operations.filter((operation) => operation.method !== 'GET').length,
                },
                unsupportedReasons: [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([reason, operations]) => ({ reason, operations })),
                features: FEATURES.map(({ feature, path }) => {
                    const operations = catalog.operations.filter((operation) => path.test(operation.path));
                    return {
                        feature,
                        advertisement:
                            operations.length === 0 ? 'not_documented' : catalog.source === 'live' ? 'live_documented' : 'bundled_documented',
                        operations: operations.length,
                        structurallyExecutable: operations.filter((operation) => !operation.unsupportedReason).length,
                        apiVersions: [
                            ...new Set(
                                operations
                                    .map((operation) => /^\/openapi\/(v\d+)\//.exec(operation.path)?.[1])
                                    .filter((value): value is string => value !== undefined)
                            ),
                        ].sort(),
                        controllerSupport: 'not_tested',
                    };
                }),
                limitations: [
                    'Structural eligibility means catalogue path/parameter/media preflight only; request schemas are compiled and validated at execution time.',
                    'These counts do not establish controller permission, tool exposure, successful execution, or hardware support.',
                    'Method counts do not classify all side effects: some non-GET operations are queries but remain excluded from read-only discovery.',
                    'Site-scoped operations require a site ID and access to that site; configured API credentials do not establish authentication or permission.',
                    'A bundled operation is snapshot documentation; even live documentation does not prove device support.',
                    'Discovery execution supports controller-scoped Open API v1/v2 routes; MSP-scoped and other versioned paths remain unsupported.',
                ],
            };
        } catch (error) {
            return { ...failure(error), reason: 'API catalogue evidence could not be collected.' };
        }
    }

    private async ssidEvidence(
        options: GetControllerCapabilitiesOptions,
        siteId: string | undefined
    ): Promise<ControllerCapabilitiesResult['ssidEvidence']> {
        if (options.wlanId === undefined || options.ssidId === undefined)
            return { status: 'not_requested', reason: 'Provide wlanId and ssidId to inspect one SSID without scanning a site.' };
        if (!siteId) return { status: 'unknown', reason: 'Provide siteId or configure OMADA_SITE_ID before requesting SSID evidence.' };
        if (!this.evidence) return { status: 'unavailable', reason: 'SSID read evidence is not configured.' };
        try {
            const snapshot = object(await this.evidence.getSsidDetail(options.wlanId, options.ssidId, siteId));
            if (!snapshot) return failure(undefined);
            const fields = Object.entries(completeSsidSchema.shape).filter(([, schema]) => !schema.isOptional());
            const missingRequiredFields = fields.filter(([field]) => !Object.hasOwn(snapshot, field)).map(([field]) => field);
            const invalidRequiredFields = fields
                .filter(([field, schema]) => Object.hasOwn(snapshot, field) && !schema.safeParse(snapshot[field]).success)
                .map(([field]) => field);
            const mlo = snapshot.mloEnable;
            const key = object(snapshot.pskSetting)?.securityKey;
            return {
                status: 'ok',
                sampleOnly: true,
                missingRequiredFields,
                invalidRequiredFields,
                mloEnable:
                    typeof mlo === 'boolean'
                        ? { availability: 'present', value: mlo }
                        : { availability: Object.hasOwn(snapshot, 'mloEnable') ? 'invalid' : 'missing' },
                securityKey:
                    snapshot.security === 3
                        ? typeof key !== 'string' || key === ''
                            ? 'missing'
                            : /^\*+$/.test(key) || key === '[redacted]'
                              ? 'hidden'
                              : 'present'
                        : typeof snapshot.security === 'number'
                          ? 'not_applicable'
                          : 'unknown',
                limitations: [
                    'This is evidence from one selected SSID, not a claim about every SSID or device.',
                    'Missing required fields must be supplied explicitly; absence is not a disabled setting.',
                    'Required basic-field presence does not establish a valid security configuration or successful mutation support.',
                ],
            };
        } catch (error) {
            return failure(error);
        }
    }
}
