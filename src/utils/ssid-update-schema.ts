import { z } from 'zod';

const integer = z.number().int();
const vlanId = integer.min(1).max(4094);
const version = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const pskSchema = z
    .object({
        securityKey: z.string().regex(/^[\x20-\x7e]{8,63}$/, 'Use 8 to 63 printable ASCII characters'),
        versionPsk: version,
        encryptionPsk: z.union([z.literal(1), z.literal(3)]),
        gikRekeyPskEnable: z.boolean(),
        rekeyPskInterval: integer.positive(),
        intervalPskType: integer.min(0).max(2),
    })
    .partial()
    .strict();
const enterpriseSchema = z
    .object({
        radiusProfileId: z.string().min(1),
        versionEnt: version,
        encryptionEnt: z.union([z.literal(1), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
        gikRekeyEntEnable: z.boolean(),
        rekeyEntInterval: integer.positive(),
        intervalEntType: integer.min(0).max(2),
        nasIdMode: integer.min(0).max(2),
        nasId: z.string(),
    })
    .partial()
    .strict();
const ppskSchema = z
    .object({
        ppskProfileId: z.string().min(1),
        radiusProfileId: z.string().min(1),
        macFormat: integer.min(0).max(5),
        nasId: z.string().max(64),
        type: integer.min(0).max(2),
    })
    .partial()
    .strict();
const vlanCustomSchema = z
    .object({
        customMode: integer,
        lanNetworkVlanIds: z.record(z.string(), z.array(vlanId)),
        vlanPoolIds: z.string(),
    })
    .partial()
    .strict();
const vlanSchema = z
    .object({ mode: integer.min(0).max(1), customConfig: vlanCustomSchema.optional() })
    .partial()
    .strict();

/** Only fields accepted by UpdateSsidBasicConfigOpenApiVO; other SSID settings have separate endpoints. */
export const ssidUpdateSchema = z
    .object({
        name: z
            .string()
            .refine(
                (value) => Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= 32,
                'SSID name must be 1 to 32 UTF-8 bytes'
            ),
        band: integer.min(1).max(7),
        guestNetEnable: z.boolean(),
        security: z.union([z.literal(0), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
        oweEnable: z.boolean(),
        broadcast: z.boolean(),
        vlanEnable: z.boolean(),
        vlanId,
        pskSetting: pskSchema,
        entSetting: enterpriseSchema,
        ppskSetting: ppskSchema,
        mloEnable: z.boolean(),
        pmfMode: integer.min(1).max(3),
        enable11r: z.boolean(),
        hidePwd: z.boolean(),
        greEnable: z.boolean(),
        vlanSetting: vlanSchema,
        prohibitWifiShare: z.boolean(),
    })
    .partial()
    .strict()
    .refine((value) => Object.keys(value).length > 0, 'At least one basic SSID setting is required');

export const completeSsidSchema = ssidUpdateSchema
    .required({
        band: true,
        broadcast: true,
        enable11r: true,
        guestNetEnable: true,
        mloEnable: true,
        name: true,
        pmfMode: true,
        security: true,
        vlanEnable: true,
    })
    .superRefine((value, context) => {
        const requireFields = (group: string, record: Record<string, unknown> | undefined, fields: string[]) => {
            for (const field of fields) {
                if (record?.[field] === undefined)
                    context.addIssue({ code: 'custom', path: [group, field], message: 'Required to preserve this security configuration' });
            }
        };
        if (value.vlanEnable && value.vlanId === undefined && value.vlanSetting?.mode !== 1) {
            context.addIssue({ code: 'custom', path: ['vlanId'], message: 'An enabled VLAN needs vlanId or custom vlanSetting' });
        }
        if ([3, 4, 5].includes(value.security)) {
            requireFields('pskSetting', value.pskSetting, ['versionPsk', 'encryptionPsk', 'gikRekeyPskEnable']);
            if (value.pskSetting?.versionPsk === 4 && value.pskSetting.encryptionPsk !== 3) {
                context.addIssue({ code: 'custom', path: ['pskSetting', 'encryptionPsk'], message: 'WPA3-SAE requires AES (3)' });
            }
        }
        if (value.security === 3) requireFields('pskSetting', value.pskSetting, ['securityKey']);
        if (value.security === 2)
            requireFields('entSetting', value.entSetting, ['radiusProfileId', 'versionEnt', 'encryptionEnt', 'gikRekeyEntEnable']);
        if (value.security === 2 && value.entSetting?.versionEnt === 4) {
            const allowed = value.band === 4 || ((value.band & 4) !== 0 && value.mloEnable) ? [4, 5, 6] : [3, 4, 5, 6];
            if (!allowed.includes(value.entSetting.encryptionEnt ?? -1)) {
                context.addIssue({
                    code: 'custom',
                    path: ['entSetting', 'encryptionEnt'],
                    message: 'Invalid WPA3-Enterprise encryption for the selected bands and MLO',
                });
            }
        }
        for (const [group, setting, suffix] of [
            ['pskSetting', [3, 4, 5].includes(value.security) ? value.pskSetting : undefined, 'Psk'],
            ['entSetting', value.security === 2 ? value.entSetting : undefined, 'Ent'],
        ] as const) {
            const record = setting as Record<string, unknown> | undefined;
            if (record?.[`gikRekey${suffix}Enable`] !== true) continue;
            const unit = record[`interval${suffix}Type`];
            const interval = record[`rekey${suffix}Interval`];
            const bounds = unit === 0 ? [30, 86400] : unit === 1 ? [1, 1440] : unit === 2 ? [1, 24] : undefined;
            if (!bounds || typeof interval !== 'number' || interval < bounds[0] || interval > bounds[1]) {
                context.addIssue({
                    code: 'custom',
                    path: [group, `rekey${suffix}Interval`],
                    message: 'Enabled rekeying requires an interval within the selected unit bounds',
                });
            }
        }
        if (value.security === 4) requireFields('ppskSetting', value.ppskSetting, ['ppskProfileId']);
        if (value.security === 5) requireFields('ppskSetting', value.ppskSetting, ['radiusProfileId', 'macFormat', 'nasId', 'type']);
        if (value.vlanSetting && value.vlanSetting.mode === undefined) {
            context.addIssue({ code: 'custom', path: ['vlanSetting', 'mode'], message: 'VLAN settings require mode' });
        }
        if (value.vlanSetting?.mode === 1 && value.vlanSetting.customConfig?.customMode === undefined) {
            context.addIssue({ code: 'custom', path: ['vlanSetting', 'customConfig'], message: 'Custom VLAN mode requires customMode' });
        }
    });

export function ssidRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function ssidSecurityGroupActive(group: string, security: unknown): boolean {
    if (group === 'pskSetting') return security === 3 || security === 4 || security === 5;
    if (group === 'entSetting') return security === 2;
    if (group === 'ppskSetting') return security === 4 || security === 5;
    return true;
}

/** Merge only documented fields, including siblings of partial nested settings. */
export function mergeSsidConfig(before: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(ssidUpdateSchema.shape)) {
        if (!ssidSecurityGroupActive(key, changes.security ?? before.security)) continue;
        const previous = before[key];
        const change = changes[key];
        if (previous !== undefined) result[key] = previous;
        if (change !== undefined) result[key] = change;
        if (ssidRecord(previous) && ssidRecord(change))
            result[key] = mergeObjects(previous as Record<string, unknown>, change as Record<string, unknown>);
    }
    if (result.vlanEnable === false && changes.vlanId === undefined) delete result.vlanId;
    return result;
}

function mergeObjects(before: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = Object.assign(Object.create(null), before);
    for (const [key, change] of Object.entries(changes)) {
        const previous = ssidRecord(before[key]);
        const nested = ssidRecord(change);
        result[key] = previous && nested ? mergeObjects(previous, nested) : change;
    }
    return result;
}
