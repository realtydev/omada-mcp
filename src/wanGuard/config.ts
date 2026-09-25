import { z } from 'zod';

const booleanString = (defaultValue: boolean) =>
    z
        .enum(['true', 'false'])
        .optional()
        .transform((value) => (value === undefined ? defaultValue : value === 'true'));

const positiveInteger = (defaultValue: number) =>
    z
        .string()
        .optional()
        .transform((value) => (value === undefined ? defaultValue : Number.parseInt(value, 10)))
        .pipe(z.number().int().positive());

const wanGuardSchema = z
    .object({
        enabled: booleanString(false),
        dryRun: booleanString(true),
        gatewayMac: z.string().trim().optional(),
        primaryPort: positiveInteger(2),
        fallbackCidrs: z
            .string()
            .optional()
            .transform((value) =>
                (value ?? '192.168.100.0/24')
                    .split(',')
                    .map((entry) => entry.trim())
                    .filter(Boolean)
            ),
        intervalMs: positiveInteger(5_000),
        failureThreshold: positiveInteger(2),
        requestTimeoutMs: positiveInteger(5_000),
    })
    .refine((value) => !value.enabled || Boolean(value.gatewayMac), {
        message: 'OMADA_WAN_GUARD_GATEWAY_MAC is required when the WAN guard is enabled',
        path: ['gatewayMac'],
    });

export interface WanGuardConfig {
    enabled: boolean;
    dryRun: boolean;
    gatewayMac: string;
    primaryPort: number;
    fallbackCidrs: string[];
    intervalMs: number;
    failureThreshold: number;
    /** Finite controller request timeout so a hung request cannot stall the poll loop. */
    requestTimeoutMs: number;
}

export function loadWanGuardConfig(env: NodeJS.ProcessEnv = process.env): WanGuardConfig {
    const parsed = wanGuardSchema.safeParse({
        enabled: env.OMADA_WAN_GUARD_ENABLED,
        dryRun: env.OMADA_WAN_GUARD_DRY_RUN,
        gatewayMac: env.OMADA_WAN_GUARD_GATEWAY_MAC,
        primaryPort: env.OMADA_WAN_GUARD_PRIMARY_PORT,
        fallbackCidrs: env.OMADA_WAN_GUARD_FALLBACK_CIDRS,
        intervalMs: env.OMADA_WAN_GUARD_INTERVAL_MS,
        failureThreshold: env.OMADA_WAN_GUARD_FAILURE_THRESHOLD,
        requestTimeoutMs: env.OMADA_TIMEOUT,
    });

    if (!parsed.success) {
        throw new Error(`Invalid WAN guard configuration:\n${parsed.error.issues.map((issue) => issue.message).join('\n')}`);
    }

    return {
        ...parsed.data,
        gatewayMac: parsed.data.gatewayMac ?? '',
    };
}
