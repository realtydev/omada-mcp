import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps invalid configuration diagnostics off MCP stdout before logging is initialized', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OMADA_') && !key.startsWith('MCP_')));
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
        cwd: tmpdir(),
        env: {
            ...env,
            OMADA_ENV_FILE: join(tmpdir(), 'omada-startup-missing.env'),
            OMADA_BASE_URL: 'invalid',
            MCP_SERVER_LOG_LEVEL: 'info',
        },
        encoding: 'utf8',
        timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid environment configuration');
});
