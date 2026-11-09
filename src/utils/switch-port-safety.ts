import { z } from 'zod';

export const switchWriteOptionsSchema = z
    .object({
        dryRun: z.boolean().optional().describe('Preview changes without writing. Default false preserves existing apply behavior.'),
        allowDisruption: z
            .boolean()
            .optional()
            .describe('Explicitly allow observed LAG/uplink/stack disruption risks. This records caller intent, not human approval.'),
    })
    .strict();
export type SwitchWriteOptions = z.infer<typeof switchWriteOptionsSchema>;
export const switchPortNumberSchema = z.number().int().min(1).max(2_147_483_647);
export const switchPortNameSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^ ?"]$|^[^ ?"][^?"]{0,126}[^ ?"]$/);
export const switchPortListSchema = z
    .array(switchPortNumberSchema)
    .min(1)
    .max(32)
    .refine((ports) => new Set(ports).size === ports.length, 'Port targets must be unique');

export type SwitchPortField = 'name' | 'profileId' | 'profileOverrideEnable' | 'poeMode' | 'status';
export type SwitchPortState = Partial<Record<SwitchPortField, string | number | boolean>> & {
    port: number;
    lagPort?: boolean;
    uplinkPort?: boolean;
    configStack?: boolean;
};
export interface SwitchPortOutcome {
    port: number;
    changes: { field: SwitchPortField; before?: string | number | boolean; after: string | number | boolean }[];
    risk: { lag: boolean | 'unknown'; uplink: boolean | 'unknown'; stack: boolean | 'unknown'; mlag: boolean | 'unknown' };
    blockers: string[];
    verification: {
        status: 'not-run' | 'verified' | 'mismatch' | 'unknown';
        attempts: number;
        mismatchedFields: string[];
        unexpectedChanges: string[];
    };
}
export interface SwitchWriteResult {
    dryRun: boolean;
    written: boolean | 'unknown';
    acknowledged: boolean;
    verificationScope: 'configured_port_fields';
    canApply: boolean;
    ports: SwitchPortOutcome[];
    warnings: string[];
}

export function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function portNumber(value: unknown): number | undefined {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && number <= 2_147_483_647 ? number : undefined;
}

/** Read configured PortInfo fields; portStatus.linkStatus is telemetry, never administrative status. */
export function switchSnapshot(value: unknown, mac: string): Map<number, SwitchPortState> {
    const detail = record(value);
    if (!detail || !Array.isArray(detail.portList)) throw new Error('Switch detail has no portList; port targets cannot be established.');
    if (typeof detail.mac === 'string' && normalizeMac(detail.mac) !== normalizeMac(mac)) throw new Error('Switch detail identifies another switch.');
    const result = new Map<number, SwitchPortState>();
    for (const entry of detail.portList) {
        const raw = record(entry);
        const port = portNumber(raw?.port);
        if (!raw || port === undefined || result.has(port)) throw new Error('Switch detail contains invalid or duplicate port identities.');
        const state: SwitchPortState = { port };
        for (const field of ['name', 'profileId'] as const) if (typeof raw[field] === 'string') state[field] = raw[field];
        for (const field of ['status', 'poeMode'] as const) {
            const configured = raw[field];
            if (configured === 0 || configured === 1 || configured === '0' || configured === '1') state[field] = Number(configured);
        }
        for (const field of ['profileOverrideEnable', 'lagPort', 'uplinkPort', 'configStack'] as const) {
            if (typeof raw[field] === 'boolean') state[field] = raw[field];
        }
        result.set(port, state);
    }
    return result;
}

export function normalizeMac(mac: string): string {
    return mac.replace(/[:-]/g, '').toLowerCase();
}

export function validateSwitchMac(mac: string): void {
    if (!/^(?:[0-9a-f]{12}|(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})$/i.test(mac)) throw new Error('switchMac must be a valid MAC address.');
}

export function portWriteOptions(dryRun?: boolean, allowDisruption?: boolean): SwitchWriteOptions | undefined {
    return dryRun === undefined && allowDisruption === undefined ? undefined : { dryRun, allowDisruption };
}
