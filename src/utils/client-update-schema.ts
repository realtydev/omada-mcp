import { isIPv4 } from 'node:net';
import { z } from 'zod';

const directionLimit = z.number().int().min(1).max(1024);
const rateUnit = z.union([z.literal(1), z.literal(2)]);

export const customClientRateLimitSchema = z
    .object({
        upEnable: z.boolean(),
        upLimit: directionLimit,
        upUnit: rateUnit,
        downEnable: z.boolean(),
        downLimit: directionLimit,
        downUnit: rateUnit,
    })
    .strict();

export const clientUpdateSchema = z
    .object({
        name: z
            .string()
            .max(128)
            .regex(/^$|^[^ +@=-]$|^[^ +@=-].{0,126}[^ ]$/, 'Client name must not start with space, +, -, @ or =, or end with space')
            .optional(),
        fixedIp: z
            .string()
            .refine((value) => value === '' || isIPv4(value), 'fixedIp must be an IPv4 address, or empty to disable')
            .optional(),
        rateLimitEnable: z.boolean().optional(),
        upLimit: directionLimit.optional().describe('Upload limit in kbps; use rateLimit for explicit Mbps units'),
        downLimit: directionLimit.optional().describe('Download limit in kbps; use rateLimit for explicit Mbps units'),
        rateLimit: z
            .discriminatedUnion('mode', [
                z.object({ mode: z.literal(0), customRateLimit: customClientRateLimitSchema }).strict(),
                z.object({ mode: z.literal(1), rateLimitProfileId: z.string().min(1) }).strict(),
            ])
            .optional()
            .describe('Complete custom configuration (units 1=kbps, 2=Mbps), or an existing rate-limit profile'),
    })
    .strict()
    .refine(
        (value) =>
            [value.name, value.fixedIp, value.rateLimitEnable, value.upLimit, value.downLimit, value.rateLimit].some((item) => item !== undefined),
        'At least one client setting is required'
    )
    .refine(
        (value) => value.rateLimit === undefined || [value.rateLimitEnable, value.upLimit, value.downLimit].every((item) => item === undefined),
        'rateLimit cannot be combined with rateLimitEnable, upLimit or downLimit'
    );
