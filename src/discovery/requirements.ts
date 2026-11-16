import { z } from 'zod';
import { dnsIpv4Schema, dnsIpv6Schema, dnsNameSchema, dnsServerSchema } from '../utils/dns-change-schema.js';
import type { ApiOperation } from './catalog.js';

const ids = z.array(z.string().trim().min(1)).min(1);
const interval = z
    .object({
        updateInterval: z.union([z.literal(0), z.literal(1), z.literal(6), z.literal(12), z.literal(24), z.literal(48), z.literal(72)]).optional(),
        customInterval: z.number().int().min(1).max(60).optional(),
    })
    .loose()
    .refine((v) => (v.updateInterval !== undefined) !== (v.customInterval !== undefined), 'Choose exactly one DDNS interval');
const ddns = z
    .object({ service: z.number().int().min(0).max(5), interval: interval.optional() })
    .loose()
    .superRefine((v, ctx) => {
        if (v.service !== 5 && !v.interval) ctx.addIssue({ code: 'custom', path: ['interval'], message: 'This service requires an interval' });
        if ((v.service === 2 || v.service === 3) && v.interval?.customInterval !== undefined)
            ctx.addIssue({ code: 'custom', path: ['interval'], message: 'This service requires updateInterval' });
    });
const lanDns = z
    .object({
        type: z.number().int().min(0).max(2),
        domain: dnsNameSchema.optional(),
        aliases: z.array(dnsNameSchema).max(7).optional(),
        lanNetworkIds: ids.optional(),
        ipAddresses: z.array(dnsIpv4Schema).max(32).optional(),
        ipv6Addresses: z.array(dnsIpv6Schema).max(32).optional(),
        cname: dnsNameSchema.or(z.literal('')).optional(),
        dnsServers: z.array(dnsServerSchema).min(1).max(2).optional(),
    })
    .loose()
    .superRefine((v, ctx) => {
        if (v.type === 2 && v.lanNetworkIds !== undefined)
            ctx.addIssue({ code: 'custom', path: ['lanNetworkIds'], message: 'Forward DNS does not support a LAN selection' });
        if (v.type !== 2 && !v.lanNetworkIds?.length)
            ctx.addIssue({ code: 'custom', path: ['lanNetworkIds'], message: 'IP and CNAME DNS require a LAN selection' });
        if (v.type === 0 && !(v.ipAddresses?.length || v.ipv6Addresses?.length))
            ctx.addIssue({ code: 'custom', path: ['ipAddresses'], message: 'IP records require an IPv4 or IPv6 address' });
        if (v.type === 1 && !v.cname) ctx.addIssue({ code: 'custom', path: ['cname'], message: 'CNAME records require a target' });
        if (v.type === 2 && !v.dnsServers?.length)
            ctx.addIssue({ code: 'custom', path: ['dnsServers'], message: 'Forward records require a DNS server' });
    });
const rateLimit = z
    .object({
        mode: z.union([z.literal(0), z.literal(1)]),
        customRateLimit: z.object({}).loose().optional(),
        rateLimitProfileId: z.string().min(1).optional(),
    })
    .loose()
    .superRefine((v, ctx) => {
        if (
            (v.mode === 0 && (!v.customRateLimit || v.rateLimitProfileId !== undefined)) ||
            (v.mode === 1 && (!v.rateLimitProfileId || v.customRateLimit !== undefined))
        )
            ctx.addIssue({ code: 'custom', message: 'Provide only the rate-limit source selected by mode' });
    });
const powerSavingFields = z
    .object({
        timeEnable: z.boolean(),
        bandEnable: z.boolean(),
        startTimeH: z.number().int().min(0).max(23).optional(),
        startTimeM: z.number().int().min(0).max(59).optional(),
        endTimeH: z.number().int().min(0).max(23).optional(),
        endTimeM: z.number().int().min(0).max(59).optional(),
        bands: z.array(z.number().int()).min(1).optional(),
        idleDuration: z.number().int().min(60).max(1440).optional(),
    })
    .loose();
function validateTriggers(v: Record<string, unknown>, ctx: z.RefinementCtx): void {
    for (const field of ['startTimeH', 'startTimeM', 'endTimeH', 'endTimeM'] as const)
        if (v.timeEnable && v[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Required when timeEnable is true' });
    for (const field of ['bands', 'idleDuration'] as const)
        if (v.bandEnable && v[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: 'Required when bandEnable is true' });
}
const powerSaving = powerSavingFields.superRefine(validateTriggers);
const powerSavingWithMode = powerSavingFields
    .partial({ timeEnable: true, bandEnable: true })
    .extend({ mode: z.number().int().min(0).max(3), bands: z.array(z.number().int().min(0).max(3)).min(1).optional() })
    .superRefine(validateTriggers)
    .superRefine((v, ctx) => {
        if (v.mode !== 1 && (v.timeEnable === true || v.bandEnable === true))
            ctx.addIssue({ code: 'custom', path: ['mode'], message: 'Time and band triggers require standard mode (1)' });
    });
const ttl = z
    .object({ customTtl: z.boolean().optional(), ttl: z.number().int().min(1).max(86400).optional() })
    .loose()
    .superRefine((v, ctx) => {
        if (v.customTtl && v.ttl === undefined) ctx.addIssue({ code: 'custom', path: ['ttl'], message: 'Custom TTL requires ttl' });
    });

/** Explicit contracts supplement vendor JSON; prose is never parsed into executable rules. */
export function validateWriteRequirements(operation: ApiOperation, body: unknown, requestSchema?: Record<string, unknown>): void {
    const route = operation.path.replace(/^\/openapi\/v1\/\{omadacId\}\/sites\/\{siteId\}/, '');
    let schema: z.ZodType | undefined;
    if (['POST', 'PATCH'].includes(operation.method) && /^\/setting\/service\/ddns(?:\/\{ddnsId\})?$/.test(route)) schema = ddns;
    if (['POST', 'PATCH'].includes(operation.method) && /^\/setting\/lan\/dns(?:\/\{dnsId\})?$/.test(route)) schema = lanDns;
    if (operation.method === 'PATCH' && route === '/lan-profiles/{profileId}')
        schema = z.object({ untagNetworkIds: z.array(z.string().min(1)) }).loose();
    if (operation.method === 'POST' && route === '/hotspot/voucher-groups') schema = z.object({ rateLimit }).loose();
    const properties = requestSchema?.properties as Record<string, unknown> | undefined;
    if (operation.method === 'PUT' && route === '/aps/{apMac}/power-saving') schema = properties?.mode ? powerSavingWithMode : powerSaving;
    if (!schema) return;
    const result = schema.safeParse(body);
    if (!result.success)
        throw new Error(
            `Invalid documented write requirements: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
        );
    if (schema === lanDns && properties?.customTtl) {
        const parsed = ttl.safeParse(body);
        if (!parsed.success) throw new Error('Invalid documented write requirements: custom TTL requires ttl in the range 1–86400');
    }
}
