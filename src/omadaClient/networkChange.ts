import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { dhcpReservationConfigSchema, reservationMacSchema } from '../utils/dhcp-reservation-schema.js';
import { completeSsidSchema, mergeSsidConfig, ssidRecord } from '../utils/ssid-update-schema.js';
import type { ApRadioOperations } from './apRadio.js';
import type { DhcpReservationOperations } from './dhcpReservation.js';
import type { NetworkOperations } from './network.js';
import { type RateLimitProfileOperations, networkChangeReceiptSchema as rateLimitReceiptSchema } from './rateLimitProfile.js';

export const changeIdentifierSchema = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^/\\%?#\s]+$/)
    .refine((value) => value !== '.' && value !== '..');
const scope = { version: z.literal(1), controllerId: changeIdentifierSchema, siteId: changeIdentifierSchema };
export const dhcpChangeConfigSchema = dhcpReservationConfigSchema.omit({ confirmConflict: true });
export const dhcpChangeReceiptSchema = z
    .object({
        ...scope,
        resource: z.literal('dhcp-reservation'),
        mac: reservationMacSchema,
        before: dhcpChangeConfigSchema.nullable(),
        applied: dhcpChangeConfigSchema.nullable(),
        beforeId: changeIdentifierSchema.nullable(),
        appliedId: changeIdentifierSchema.nullable(),
    })
    .strict()
    .superRefine((value, ctx) => {
        const canonical = (mac: string) => mac.replaceAll(':', '-').toUpperCase();
        for (const key of ['before', 'applied'] as const) {
            const config = value[key];
            if (config && canonical(config.mac) !== canonical(value.mac))
                ctx.addIssue({ code: 'custom', path: [key, 'mac'], message: 'Receipt MAC does not match target' });
            if ((config === null) !== (value[`${key}Id`] === null))
                ctx.addIssue({ code: 'custom', path: [`${key}Id`], message: 'Reservation identity must match presence' });
        }
        if (value.before === null && value.applied === null) ctx.addIssue({ code: 'custom', message: 'Receipt must describe a change' });
        if (value.before && value.applied && value.beforeId !== value.appliedId)
            ctx.addIssue({ code: 'custom', message: 'Reservation updates must preserve row identity' });
    });
export type DhcpChangeReceipt = z.infer<typeof dhcpChangeReceiptSchema>;

/** A complete secret-free SSID snapshot. Password-bearing modes are deliberately not serialized. */
export const ssidChangeConfigSchema = z
    .object({ ...completeSsidSchema.shape, security: z.union([z.literal(0), z.literal(2)]) })
    .omit({ pskSetting: true, ppskSetting: true })
    .strict()
    .superRefine((value, context) => {
        const parsed = completeSsidSchema.safeParse(value);
        if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    });
export const ssidChangeReceiptSchema = z
    .object({
        ...scope,
        resource: z.literal('ssid-basic'),
        wlanId: changeIdentifierSchema,
        ssidId: changeIdentifierSchema,
        before: ssidChangeConfigSchema,
        applied: ssidChangeConfigSchema,
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.before.security !== value.applied.security || !sameShape(value.before, value.applied))
            ctx.addIssue({ code: 'custom', message: 'Receipt cannot restore a security-mode or field-presence transition' });
    });
export type SsidChangeReceipt = z.infer<typeof ssidChangeReceiptSchema>;

export const radioBandConfigSchema = z
    .object({
        radioEnable: z.boolean(),
        channelRange: z.array(z.number().int()).max(256).optional(),
        channelWidth: z
            .string()
            .regex(/^([2-9]|10)$/)
            .optional(),
        channel: z.string().regex(/^\d+$/).max(8).optional(),
        txPower: z.number().int().optional(),
        txPowerLevel: z.number().int().min(0).max(4).optional(),
        freq: z.number().int().nonnegative().optional(),
        wirelessMode: z.number().int().optional(),
    })
    .strict()
    .superRefine((value, context) => {
        if (value.radioEnable) {
            for (const field of ['channelWidth', 'channel', 'txPowerLevel', 'wirelessMode'] as const)
                if (value[field] === undefined) context.addIssue({ code: 'custom', path: [field], message: 'Enabled radio evidence is incomplete' });
            if (value.txPowerLevel === 3 && value.txPower === undefined)
                context.addIssue({ code: 'custom', path: ['txPower'], message: 'Custom power evidence is incomplete' });
        }
        if (value.channel !== undefined && value.channel !== '0' && value.freq === undefined)
            context.addIssue({ code: 'custom', path: ['freq'], message: 'Manual channel requires matching frequency evidence' });
    });
export const radioConfigSchema = z
    .object({
        radioSetting2g: radioBandConfigSchema.optional(),
        radioSetting5g: radioBandConfigSchema.optional(),
        radioSetting5g1: radioBandConfigSchema.optional(),
        radioSetting5g2: radioBandConfigSchema.optional(),
        radioSetting6g: radioBandConfigSchema.optional(),
    })
    .strict();
export const apRadioChangeReceiptSchema = z
    .object({
        ...scope,
        resource: z.literal('ap-radio'),
        apMac: reservationMacSchema,
        band: z.enum(['2g', '5g', '5g2', '6g']),
        before: radioConfigSchema,
        applied: radioConfigSchema,
    })
    .strict()
    .superRefine((value, ctx) => {
        const key = { '2g': 'radioSetting2g', '5g': 'radioSetting5g', '5g2': 'radioSetting5g2', '6g': 'radioSetting6g' }[
            value.band
        ] as keyof typeof value.before;
        if (!value.before[key] || !value.applied[key] || !sameShape(value.before, value.applied))
            ctx.addIssue({ code: 'custom', message: 'Receipt requires matching complete radio field presence' });
        for (const band of Object.keys(value.before) as (keyof typeof value.before)[])
            if (band !== key && !isDeepStrictEqual(value.before[band], value.applied[band]))
                ctx.addIssue({ code: 'custom', message: 'Receipt must describe one radio band only' });
    });
export type ApRadioChangeReceipt = z.infer<typeof apRadioChangeReceiptSchema>;
export const networkChangeReceiptSchema = z.discriminatedUnion('resource', [
    rateLimitReceiptSchema,
    dhcpChangeReceiptSchema,
    ssidChangeReceiptSchema,
    apRadioChangeReceiptSchema,
]);
export type NetworkChangeReceipt = z.infer<typeof networkChangeReceiptSchema>;

/** Field presence matters: a partial PATCH cannot safely remove a previously absent field. */
export function sameShape(left: unknown, right: unknown): boolean {
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right);
    const a = ssidRecord(left),
        b = ssidRecord(right);
    if (!a || !b) return !a && !b;
    const keys = Object.keys(a)
        .filter((k) => a[k] !== undefined)
        .sort();
    return (
        isDeepStrictEqual(
            keys,
            Object.keys(b)
                .filter((k) => b[k] !== undefined)
                .sort()
        ) && keys.every((k) => sameShape(a[k], b[k]))
    );
}
export function safeSsidChangeConfig(value: unknown): z.infer<typeof ssidChangeConfigSchema> | undefined {
    const record = ssidRecord(value);
    if (!record) return undefined;
    const parsed = ssidChangeConfigSchema.safeParse(mergeSsidConfig(record, {}));
    return parsed.success ? parsed.data : undefined;
}
export function radioChangeConfig(value: unknown): z.infer<typeof radioConfigSchema> | undefined {
    const record = ssidRecord(value);
    if (!record) return undefined;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(radioConfigSchema.shape)) {
        const band = ssidRecord(record[key]);
        if (!band) continue;
        const fields = Object.fromEntries(
            Object.keys(radioBandConfigSchema.shape)
                .filter((field) => band[field] !== undefined)
                .map((field) => [field, band[field]])
        );
        if (fields.channel === '0') delete fields.freq;
        const parsed = radioBandConfigSchema.safeParse(fields);
        if (!parsed.success) return undefined;
        result[key] = parsed.data;
    }
    const parsed = radioConfigSchema.safeParse(result);
    return parsed.success && Object.keys(parsed.data).length ? parsed.data : undefined;
}

/** Receipt dispatch is explicit; the caller still enforces resource-specific write permissions. */
export class NetworkChangeOperations {
    constructor(
        private readonly controllerId: string,
        private readonly rates: Pick<RateLimitProfileOperations, 'rollbackNetworkChange'>,
        private readonly network: Pick<NetworkOperations, 'rollbackSsidChange'>,
        private readonly dhcp: Pick<DhcpReservationOperations, 'rollbackDhcpChange'>,
        private readonly radios: Pick<ApRadioOperations, 'rollbackApRadioChange'>
    ) {}
    public async rollbackNetworkChange(receipt: NetworkChangeReceipt, dryRun = true): Promise<unknown> {
        const parsed = networkChangeReceiptSchema.parse(receipt);
        if (parsed.controllerId !== this.controllerId) throw new Error('Rollback receipt belongs to a different controller');
        if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean');
        switch (parsed.resource) {
            case 'rate-limit-profile':
                return await this.rates.rollbackNetworkChange(parsed, dryRun);
            case 'ssid-basic':
                return await this.network.rollbackSsidChange(parsed, dryRun);
            case 'dhcp-reservation':
                return await this.dhcp.rollbackDhcpChange(parsed, dryRun);
            case 'ap-radio':
                return await this.radios.rollbackApRadioChange(parsed, dryRun);
        }
    }
}
