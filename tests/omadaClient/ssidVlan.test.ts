import { describe, expect, it } from 'vitest';
import { inheritedSsidVlans, resolveSsidVlan, vlanSetting } from '../../src/omadaClient/ssidVlan.js';

describe('SSID VLAN inheritance evidence', () => {
    it('resolves an inherited VLAN despite no AP VLAN override', () => {
        expect(resolveSsidVlan({ overrideVlanEnable: false }, vlanSetting({ vlanId: 20, vlanPoolIds: '20' }, true))).toEqual({
            scope: 'configured_ssid_tagging',
            override: { status: 'known', enabled: false },
            inherited: { status: 'resolved', mode: 'explicit_vlan', vlanId: 20 },
            effective: { status: 'resolved', mode: 'explicit_vlan', vlanId: 20, source: 'wlan_ssid' },
        });
    });
    it('gives the active AP override precedence while retaining the parent setting', () => {
        expect(resolveSsidVlan({ overrideVlanEnable: true, vlanId: 10 }, vlanSetting({ vlanId: 20 }, true))).toMatchObject({
            inherited: { vlanId: 20 },
            effective: { status: 'resolved', source: 'ap_override', vlanId: 10 },
        });
    });
    it('resolves an AP override without a readable parent and retains native pool representation', () => {
        expect(resolveSsidVlan({ overrideVlanEnable: true, vlanPoolIds: '20,30' }, undefined)).toMatchObject({
            inherited: { status: 'unknown' },
            effective: { status: 'resolved', vlanPoolIds: '20,30', source: 'ap_override' },
        });
    });
    it('does not promote dormant override values or guess a numeric default VLAN', () => {
        const r = resolveSsidVlan({ overrideVlanEnable: false, vlanId: 99 }, vlanSetting({ vlanId: 20 }, false));
        expect(r.effective).toEqual({ status: 'resolved', mode: 'default_network', source: 'wlan_ssid' });
        expect(r.effective).not.toHaveProperty('vlanId');
    });
    it('leaves effective state unknown without AP flags even when the parent VLAN is known', () => {
        expect(resolveSsidVlan(undefined, vlanSetting({ vlanId: 20 }, true))).toMatchObject({
            override: { status: 'unknown' },
            inherited: { status: 'resolved', vlanId: 20 },
            effective: { status: 'unknown', source: 'unknown' },
        });
    });
    it.each([{ overrideVlanEnable: true }, { overrideVlanEnable: true, vlanId: 0 }, { overrideVlanEnable: false }])(
        'never treats incomplete evidence as an untagged SSID: %j',
        (configured) => {
            expect(resolveSsidVlan(configured, undefined).effective.status).toBe('unknown');
        }
    );
    it('joins by stable SSID ID, permits duplicate names and never retains names or credentials', () => {
        const rows = inheritedSsidVlans([
            { ssidId: 'one', id: 'one', name: 'same', vlanEnable: true, vlanId: 20, password: 'secret' },
            { ssidId: 'two', name: 'same', vlanEnable: true, vlanId: 30, password: 'secret' },
        ]);
        expect(rows.get('one')).toMatchObject({ vlanId: 20 });
        expect(rows.get('two')).toMatchObject({ vlanId: 30 });
        expect(JSON.stringify([...rows])).not.toContain('secret');
    });
    it.each([
        [
            { id: 'one', vlanEnable: true, vlanId: 20 },
            { id: 'one', vlanEnable: true, vlanId: 30 },
        ],
        [{ id: 'one', ssidId: 'two', vlanEnable: false }],
        [{ name: 'one', vlanEnable: false }],
        Array.from({ length: 257 }, (_, i) => ({ id: String(i), vlanEnable: false })),
    ])('rejects ambiguous/oversized parent inventories', (rows) => {
        expect(() => inheritedSsidVlans(rows)).toThrow();
    });
    it.each([
        { vlanEnable: true },
        { vlanEnable: true, vlanId: 4095 },
        { vlanEnable: true, vlanId: '20' },
        { vlanEnable: true, vlanPoolIds: {} },
        { vlanEnable: true, vlanSetting: { mode: 1 }, vlanId: 20 },
        {},
    ])('keeps missing/new VLAN contracts unknown: %j', (row) => {
        expect(inheritedSsidVlans([{ id: 'one', ...row }]).get('one')?.status).toBe('unknown');
    });
});
