import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyWrite } from '../../src/utils/write-verification.js';

describe('write verification', () => {
    afterEach(() => vi.useRealTimers());

    it('finishes immediately when read-back matches', async () => {
        const read = vi.fn().mockResolvedValue({ status: true });
        await expect(verifyWrite(read, (state) => state.status)).resolves.toEqual({ status: 'verified', attempts: 1, observed: { status: true } });
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('does not call a failed read successful or retry beyond the bound', async () => {
        vi.useFakeTimers();
        const read = vi.fn().mockRejectedValue(new Error('Read failed'));
        const pending = verifyWrite(read, () => true);
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({ status: 'unknown', attempts: 3, message: 'Read failed' });
        expect(read).toHaveBeenCalledTimes(3);
    });

    it('distinguishes an observed mismatch from unavailable evidence', async () => {
        vi.useFakeTimers();
        const read = vi.fn().mockResolvedValue(false);
        const pending = verifyWrite(read, (state) => state);
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toMatchObject({ status: 'mismatch', observed: false, attempts: 3 });
    });
});
