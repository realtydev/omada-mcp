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
        message: 'required when the WAN guard is enabled',
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

const ENV_NAMES: Record<keyof z.input<typeof wanGuardSchema>, string> = {
    enabled: 'OMADA_WAN_GUARD_ENABLED',
    dryRun: 'OMADA_WAN_GUARD_DRY_RUN',
    gatewayMac: 'OMADA_WAN_GUARD_GATEWAY_MAC',
    primaryPort: 'OMADA_WAN_GUARD_PRIMARY_PORT',
    fallbackCidrs: 'OMADA_WAN_GUARD_FALLBACK_CIDRS',
    intervalMs: 'OMADA_WAN_GUARD_INTERVAL_MS',
    failureThreshold: 'OMADA_WAN_GUARD_FAILURE_THRESHOLD',
    requestTimeoutMs: 'OMADA_TIMEOUT',
};

export function loadWanGuardConfig(env: NodeJS.ProcessEnv = process.env): WanGuardConfig {
    const input = Object.fromEntries(Object.entries(ENV_NAMES).map(([key, name]) => [key, env[name]]));
    const parsed = wanGuardSchema.safeParse(input);

    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => {
            const name = ENV_NAMES[issue.path[0] as keyof typeof ENV_NAMES];
            return name ? `${name}: ${issue.message}` : issue.message;
        });
        throw new Error(`Invalid WAN guard configuration:\n${issues.join('\n')}`);
    }

    return {
        ...parsed.data,
        gatewayMac: parsed.data.gatewayMac ?? '',
    };
}
