import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadEnvModule() {
    return await import('../src/env.js');
}

describe('env loader', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('loads base env and local overrides when available', async () => {
        const configMock = vi.fn();
        const existsMock = vi.fn().mockReturnValue(true);

        vi.doMock('dotenv', () => ({
            config: configMock,
        }));
        vi.doMock('node:fs', () => ({
            existsSync: existsMock,
        }));

        await loadEnvModule();

        expect(configMock).toHaveBeenNthCalledWith(1, { path: '.env', quiet: true });
        expect(configMock).toHaveBeenNthCalledWith(2, { path: '.env.local', override: true, quiet: true });
        expect(existsMock).toHaveBeenCalledWith('.env.local');
    });

    it('skips local overrides when file is missing', async () => {
        const configMock = vi.fn();
        const existsMock = vi.fn().mockReturnValue(false);

        vi.doMock('dotenv', () => ({
            config: configMock,
        }));
        vi.doMock('node:fs', () => ({
            existsSync: existsMock,
        }));

        await loadEnvModule();

        expect(configMock).toHaveBeenCalledTimes(1);
        expect(configMock).toHaveBeenCalledWith({ path: '.env', quiet: true });
    });

    it('never writes to stdout, which carries the MCP stdio protocol', async () => {
        vi.doUnmock('dotenv');
        vi.doUnmock('node:fs');
        const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await loadEnvModule();
            expect(stdoutWrite).not.toHaveBeenCalled();
            expect(consoleLog).not.toHaveBeenCalled();
        } finally {
            stdoutWrite.mockRestore();
            consoleLog.mockRestore();
        }
    });
});
