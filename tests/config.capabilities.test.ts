import { describe, expect, it } from 'vitest';
import { loadConfigFromEnv } from '../src/config.js';

const base = {
    OMADA_BASE_URL: 'https://controller.example.com',
    OMADA_CLIENT_ID: 'client',
    OMADA_CLIENT_SECRET: 'secret',
    OMADA_OMADAC_ID: 'controller',
};
describe('MSP and transfer configuration', () => {
    it('keeps controller, authentication principal and MSP IDs distinct', () => {
        const config = loadConfigFromEnv({ ...base, OMADA_MSP_ID: 'msp-id', OMADA_AUTH_ID: 'principal-id' });
        expect(config).toMatchObject({ omadacId: 'controller', mspId: 'msp-id', authId: 'principal-id' });
    });
    it('disables file transfer until an operator configures a directory', () => {
        expect(loadConfigFromEnv(base)).toMatchObject({ transferDirectory: undefined, maxTransferBytes: 16 * 1024 * 1024 });
        expect(loadConfigFromEnv({ ...base, OMADA_TRANSFER_DIR: '/var/lib/omada/transfers', OMADA_MAX_TRANSFER_BYTES: '1048576' })).toMatchObject({
            transferDirectory: '/var/lib/omada/transfers',
            maxTransferBytes: 1048576,
        });
        expect(() => loadConfigFromEnv({ ...base, OMADA_TRANSFER_DIR: 'relative' })).toThrow('absolute');
        for (const value of ['0', '-1', '1.5', '1MB', String(65 * 1024 * 1024)])
            expect(() => loadConfigFromEnv({ ...base, OMADA_MAX_TRANSFER_BYTES: value })).toThrow();
    });
});
