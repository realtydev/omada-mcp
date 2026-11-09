/** Resolve configured SSID tagging without treating an absent AP override as an untagged SSID. */
type Row = Record<string, unknown>;
export type SsidVlanSetting =
    | { status: 'resolved'; mode: 'explicit_vlan'; vlanId?: number; vlanPoolIds?: string }
    | { status: 'resolved'; mode: 'default_network' }
    | { status: 'unknown'; reason: string };
export interface SsidVlanEvidence {
    scope: 'configured_ssid_tagging';
    override: { status: 'known'; enabled: boolean } | { status: 'unknown' };
    inherited: SsidVlanSetting;
    effective: SsidVlanSetting & { source: 'ap_override' | 'wlan_ssid' | 'unknown' };
}
const object = (v: unknown): Row | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : undefined);
const unknown = (reason: string): SsidVlanSetting => ({ status: 'unknown', reason });
export function vlanSetting(value: Row, enabled: unknown): SsidVlanSetting {
    if (typeof enabled !== 'boolean') return unknown('VLAN enablement was not established.');
    if (!enabled) return { status: 'resolved', mode: 'default_network' };
    const id = value.vlanId,
        pool = value.vlanPoolIds;
    if (id !== undefined && (!Number.isInteger(id) || Number(id) < 1 || Number(id) > 4094)) return unknown('VLAN ID is invalid.');
    if (pool !== undefined && (typeof pool !== 'string' || pool.length > 2048)) return unknown('VLAN pool representation is invalid.');
    const usablePool = typeof pool === 'string' && pool.trim() ? pool : undefined;
    if (id === undefined && !usablePool) return unknown('Enabled VLAN settings omit a usable ID or pool.');
    return {
        status: 'resolved',
        mode: 'explicit_vlan',
        ...(id !== undefined ? { vlanId: Number(id) } : {}),
        ...(usablePool !== undefined && usablePool !== String(id) ? { vlanPoolIds: usablePool } : {}),
    };
}
export function inheritedSsidVlans(value: unknown): Map<string, SsidVlanSetting> {
    if (!Array.isArray(value) || value.length > 256) throw new Error('Invalid WLAN SSID inventory');
    const result = new Map<string, SsidVlanSetting>();
    for (const entry of value) {
        const row = object(entry);
        const id = row?.ssidId ?? row?.id;
        if (
            !row ||
            typeof id !== 'string' ||
            !id ||
            id.length > 256 ||
            result.has(id) ||
            (row.ssidId !== undefined && row.id !== undefined && row.ssidId !== row.id)
        )
            throw new Error('Ambiguous WLAN SSID identities');
        result.set(
            id,
            row.vlanSetting !== undefined ? unknown('Advanced VLAN settings are outside this resolver contract.') : vlanSetting(row, row.vlanEnable)
        );
    }
    return result;
}
export function resolveSsidVlan(
    configured: { overrideVlanEnable?: unknown; vlanId?: unknown; vlanPoolIds?: unknown } | undefined,
    inherited: SsidVlanSetting | undefined
): SsidVlanEvidence {
    const parent = inherited ?? unknown('Matching WLAN SSID VLAN evidence was not available.');
    const flag = configured?.overrideVlanEnable;
    if (typeof flag !== 'boolean')
        return {
            scope: 'configured_ssid_tagging',
            override: { status: 'unknown' },
            inherited: parent,
            effective: { ...unknown('AP VLAN override enablement was not established.'), source: 'unknown' },
        };
    const effective = flag ? vlanSetting(configured!, true) : parent;
    return {
        scope: 'configured_ssid_tagging',
        override: { status: 'known', enabled: flag },
        inherited: parent,
        effective: { ...effective, source: effective.status === 'resolved' ? (flag ? 'ap_override' : 'wlan_ssid') : 'unknown' },
    };
}
