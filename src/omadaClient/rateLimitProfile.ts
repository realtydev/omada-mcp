import { isDeepStrictEqual } from 'node:util';
import axios from 'axios';
import { z } from 'zod';

import type { OmadaApiResponse } from '../types/index.js';
import { verifyWrite, type WriteVerification } from '../utils/write-verification.js';
import type { RequestHandler } from './request.js';
import type { SiteOperations } from './site.js';

const MAX_LIMIT_KBPS = 10_485_760;
const writableFields = ['name', 'upLimitEnable', 'upLimit', 'downLimitEnable', 'downLimit'] as const;
const identifierSchema = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^/\\%?#\s]+$/)
    .refine((value) => value !== '.' && value !== '..', 'Invalid identifier');
const fields = {
    name: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[^ ]$|^[^ ].{0,62}[^ ]$/, 'Profile name must not start or end with a space'),
    upLimitEnable: z.boolean(),
    // Controllers may retain zero for disabled directions. Enabled directions require a positive limit below.
    upLimit: z.number().int().min(0).max(MAX_LIMIT_KBPS).optional(),
    downLimitEnable: z.boolean(),
    downLimit: z.number().int().min(0).max(MAX_LIMIT_KBPS).optional(),
};

export const rateLimitProfileConfigSchema = z
    .object(fields)
    .strict()
    .superRefine((value, context) => {
        for (const direction of ['up', 'down'] as const) {
            const limit = value[`${direction}Limit`];
            if (value[`${direction}LimitEnable`] && !(typeof limit === 'number' && limit >= 1)) {
                context.addIssue({
                    code: 'custom',
                    path: [`${direction}Limit`],
                    message: `An enabled ${direction}load limit requires 1–${MAX_LIMIT_KBPS} kbps`,
                });
            }
        }
    });
export const rateLimitProfileUpdateSchema = z
    .object(fields)
    .partial()
    .strict()
    .refine((value) => Object.values(value).some((field) => field !== undefined), 'At least one rate-limit profile setting is required');
export type RateLimitProfileConfig = z.infer<typeof rateLimitProfileConfigSchema>;
export type RateLimitProfileUpdate = z.infer<typeof rateLimitProfileUpdateSchema>;

/** Caller-held validated data, not a bearer credential or server authorization token. */
export const networkChangeReceiptSchema = z
    .object({
        version: z.literal(1),
        resource: z.literal('rate-limit-profile'),
        controllerId: identifierSchema,
        siteId: identifierSchema,
        profileId: identifierSchema,
        before: rateLimitProfileConfigSchema,
        applied: rateLimitProfileConfigSchema,
    })
    .strict();
export type NetworkChangeReceipt = z.infer<typeof networkChangeReceiptSchema>;

export interface RateLimitProfileChange {
    field: (typeof writableFields)[number];
    before: unknown;
    after: unknown;
}
export interface RateLimitProfileWriteResult {
    operation: 'update' | 'rollback';
    resource: 'rate-limit-profile';
    profileId: string;
    siteId: string;
    dryRun: boolean;
    written: boolean | 'unknown';
    verified: boolean;
    changes: RateLimitProfileChange[];
    before: RateLimitProfileConfig;
    after?: RateLimitProfileConfig;
    requestBody?: RateLimitProfileConfig;
    verification?: Omit<WriteVerification<RateLimitProfileConfig>, 'observed'>;
    rollbackReceipt?: NetworkChangeReceipt;
    writeError?: string;
    warning?: string;
}

function same(left: RateLimitProfileConfig, right: RateLimitProfileConfig): boolean {
    return writableFields.every((field) => isDeepStrictEqual(left[field], right[field]));
}

function definiteRejection(error: unknown): boolean {
    const status = axios.isAxiosError(error)
        ? error.response?.status
        : Number((error instanceof Error ? error.message : '').match(/HTTP\s+(\d{3})/)?.[1]);
    return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

/** Verified updates and drift-aware rollback for public Open API rate-limit profiles. */
export class RateLimitProfileOperations {
    constructor(
        private readonly request: RequestHandler,
        private readonly site: SiteOperations,
        private readonly buildPath: (path: string) => string,
        private readonly controllerId: string
    ) {
        identifierSchema.parse(controllerId);
    }

    public async updateRateLimitProfile(
        profileId: string,
        settings: RateLimitProfileUpdate,
        siteId?: string,
        dryRun = true
    ): Promise<RateLimitProfileWriteResult> {
        const id = identifierSchema.parse(profileId);
        const update = rateLimitProfileUpdateSchema.parse(settings);
        const resolvedSiteId = identifierSchema.parse(this.site.resolveSiteId(siteId));
        if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean');
        const before = await this.read(id, resolvedSiteId);
        const desired = rateLimitProfileConfigSchema.parse({
            ...before,
            ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
        });
        return await this.apply('update', id, resolvedSiteId, before, desired, dryRun);
    }

    public async rollbackNetworkChange(receipt: NetworkChangeReceipt, dryRun = true): Promise<RateLimitProfileWriteResult> {
        const parsed = networkChangeReceiptSchema.parse(receipt);
        if (parsed.controllerId !== this.controllerId) throw new Error('Rollback receipt belongs to a different controller');
        if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean');
        const current = await this.read(parsed.profileId, parsed.siteId);
        // A repeated rollback is a safe no-op only when the exact original configuration is already present.
        if (same(current, parsed.before)) return this.unchanged('rollback', parsed.profileId, parsed.siteId, current, dryRun);
        if (!same(current, parsed.applied))
            throw new Error(
                'Rollback refused: rate-limit profile changed after this receipt was issued. Inspect current settings before making another change.'
            );
        return await this.apply('rollback', parsed.profileId, parsed.siteId, current, parsed.before, dryRun);
    }

    private async read(profileId: string, siteId: string): Promise<RateLimitProfileConfig> {
        const path = this.buildPath(`/sites/${encodeURIComponent(siteId)}/rate-limit-profiles`);
        const response = await this.request.get<OmadaApiResponse<unknown>>(path);
        const rows = this.request.ensureSuccess(response);
        if (!Array.isArray(rows)) throw new Error('Rate-limit profile evidence is incomplete: expected a profile list');
        const seen = new Set<string>();
        let match: Record<string, unknown> | undefined;
        for (const row of rows) {
            if (!row || typeof row !== 'object' || Array.isArray(row)) {
                throw new Error('Rate-limit profile evidence is incomplete: a row has no valid profile ID');
            }
            // Current controllers expose profileId; older OpenAPI snapshots document id.
            const candidate = row as Record<string, unknown>;
            const identifiers = ['profileId', 'id'].filter((key) => Object.hasOwn(candidate, key)).map((key) => candidate[key]);
            if (identifiers.length === 0 || identifiers.some((id) => !identifierSchema.safeParse(id).success)) {
                throw new Error('Rate-limit profile evidence is incomplete: a row has no valid profile ID');
            }
            const canonicalId = identifiers[0] as string;
            if (identifiers.some((id) => id !== canonicalId)) {
                throw new Error('Rate-limit profile evidence is incomplete: conflicting profile ID fields');
            }
            if (seen.has(canonicalId)) throw new Error('Rate-limit profile evidence is incomplete: duplicate profile IDs');
            seen.add(canonicalId);
            if (canonicalId === profileId) match = row as Record<string, unknown>;
        }
        if (!match) throw new Error('Rate-limit profile does not exist');
        const config = Object.fromEntries(writableFields.filter((field) => match[field] !== undefined).map((field) => [field, match[field]]));
        const parsed = rateLimitProfileConfigSchema.safeParse(config);
        if (!parsed.success) throw new Error('Rate-limit profile evidence is incomplete: required writable settings cannot be preserved');
        return parsed.data;
    }

    private unchanged(
        operation: RateLimitProfileWriteResult['operation'],
        profileId: string,
        siteId: string,
        before: RateLimitProfileConfig,
        dryRun: boolean
    ): RateLimitProfileWriteResult {
        return {
            operation,
            resource: 'rate-limit-profile',
            profileId,
            siteId,
            dryRun,
            written: false,
            verified: true,
            changes: [],
            before,
            after: before,
            verification: { status: 'verified', attempts: 0 },
        };
    }

    private async apply(
        operation: RateLimitProfileWriteResult['operation'],
        profileId: string,
        siteId: string,
        before: RateLimitProfileConfig,
        desired: RateLimitProfileConfig,
        dryRun: boolean
    ): Promise<RateLimitProfileWriteResult> {
        const changes = writableFields
            .filter((field) => !isDeepStrictEqual(before[field], desired[field]))
            .map((field) => ({ field, before: before[field], after: desired[field] }));
        if (changes.length === 0) return this.unchanged(operation, profileId, siteId, before, dryRun);
        const base = { operation, resource: 'rate-limit-profile' as const, profileId, siteId, changes, before, requestBody: desired };
        if (dryRun) return { ...base, dryRun: true, written: false, verified: false };
        let response: OmadaApiResponse<unknown> | undefined;
        let writeError: string | undefined;
        try {
            response = await this.request.request<OmadaApiResponse<unknown>>({
                method: 'PUT',
                url: this.buildPath(`/sites/${encodeURIComponent(siteId)}/rate-limit-profile/${encodeURIComponent(profileId)}`),
                data: desired,
            });
        } catch (error) {
            if (definiteRejection(error)) throw error;
            writeError = error instanceof Error ? error.message : String(error);
        }
        if (response !== undefined) this.request.ensureSuccess(response);
        const verification = await verifyWrite(
            () => this.read(profileId, siteId),
            (observed) => same(observed, desired)
        );
        const verified = verification.status === 'verified';
        return {
            ...base,
            dryRun: false,
            written: writeError && !verified ? 'unknown' : true,
            verified,
            after: verification.observed,
            verification: { status: verification.status, attempts: verification.attempts, message: verification.message },
            ...(verified
                ? {
                      rollbackReceipt: networkChangeReceiptSchema.parse({
                          version: 1,
                          resource: 'rate-limit-profile',
                          controllerId: this.controllerId,
                          siteId,
                          profileId,
                          before,
                          applied: verification.observed,
                      }),
                  }
                : {}),
            ...(writeError ? { writeError } : {}),
            ...(!verified
                ? {
                      warning:
                          'The write may have applied but could not be verified. Inspect current profile settings before retrying; no rollback receipt was issued.',
                  }
                : {}),
        };
    }
}
