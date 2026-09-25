import { describe, expect, it } from 'vitest';

import { loadWanGuardConfig } from '../../src/wanGuard/config.js';

describe('loadWanGuardConfig', () => {
    it('defaults to disabled and dry-run so nothing changes without opting in', () => {
        expect(loadWanGuardConfig({})).toEqual({
            enabled: false,
            dryRun: true,
            gatewayMac: '',
            primaryPort: 2,
            fallbackCidrs: ['192.168.100.0/24'],
            intervalMs: 5000,
            failureThreshold: 2,
            requestTimeoutMs: 5000,
        });
    });

    it('parses every setting from the environment', () => {
        const config = loadWanGuardConfig({
            OMADA_WAN_GUARD_ENABLED: 'true',
            OMADA_WAN_GUARD_DRY_RUN: 'false',
            OMADA_WAN_GUARD_GATEWAY_MAC: ' AA-BB-CC-DD-EE-FF ',
            OMADA_WAN_GUARD_PRIMARY_PORT: '1',
            OMADA_WAN_GUARD_FALLBACK_CIDRS: '192.168.100.0/24, 10.0.0.0/8',
            OMADA_WAN_GUARD_INTERVAL_MS: '10000',
            OMADA_WAN_GUARD_FAILURE_THRESHOLD: '3',
            OMADA_TIMEOUT: '2500',
        });

        expect(config).toEqual({
            enabled: true,
            dryRun: false,
            gatewayMac: 'AA-BB-CC-DD-EE-FF',
            primaryPort: 1,
            fallbackCidrs: ['192.168.100.0/24', '10.0.0.0/8'],
            intervalMs: 10000,
            failureThreshold: 3,
            requestTimeoutMs: 2500,
        });
    });

    it('requires a gateway MAC once enabled', () => {
        expect(() => loadWanGuardConfig({ OMADA_WAN_GUARD_ENABLED: 'true' })).toThrow('OMADA_WAN_GUARD_GATEWAY_MAC: required when the WAN guard is enabled');
    });

    it('names the offending variable when a numeric setting is invalid', () => {
        expect(() => loadWanGuardConfig({ OMADA_WAN_GUARD_FAILURE_THRESHOLD: '0' })).toThrow('OMADA_WAN_GUARD_FAILURE_THRESHOLD');
        expect(() => loadWanGuardConfig({ OMADA_WAN_GUARD_INTERVAL_MS: 'abc' })).toThrow('OMADA_WAN_GUARD_INTERVAL_MS');
    });
});
