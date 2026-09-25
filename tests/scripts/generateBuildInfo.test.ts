import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const generatedPath = join(repoRoot, 'src', 'generated', 'buildInfo.ts');

describe('scripts/generate-build-info.mjs', () => {
    it('should write PACKAGE_VERSION matching package.json and a well-formed GIT_COMMIT/BUILD_TIME', () => {
        execFileSync(process.execPath, [join(repoRoot, 'scripts', 'generate-build-info.mjs')], { cwd: repoRoot });

        const written = readFileSync(generatedPath, 'utf8');
        const packageVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
        const expectedCommit = execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim();

        expect(written).toContain(`export const PACKAGE_VERSION = ${JSON.stringify(packageVersion)};`);
        // The working tree may be dirty (mid-edit, like this worktree usually is) or clean; either is valid, but it
        // must be one or the other and must be built on the real current HEAD, not a stale or placeholder value.
        expect(written).toMatch(new RegExp(`export const GIT_COMMIT = "${expectedCommit}(-dirty)?";`));
        expect(written).toMatch(/export const BUILD_TIME = "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z";/);
    });

    it('should fall back to "unknown" rather than fail when git is unavailable', () => {
        // Simulate a context without git (e.g. the Docker build, whose .dockerignore excludes .git) by pointing
        // PATH somewhere with no git binary, rather than actually removing .git from this repo. Spawn node by its
        // absolute path (process.execPath) so only the script's *internal* `git ...` lookups are affected — an
        // overridden PATH would otherwise also stop the child process from finding `node` itself to run at all.
        execFileSync(process.execPath, [join(repoRoot, 'scripts', 'generate-build-info.mjs')], {
            cwd: repoRoot,
            env: { ...process.env, PATH: '/nonexistent' },
        });

        const written = readFileSync(generatedPath, 'utf8');
        expect(written).toContain('export const GIT_COMMIT = "unknown";');

        // Restore a real build-info file so the rest of the suite (which imports from src/generated/buildInfo.js) isn't left broken.
        execFileSync(process.execPath, [join(repoRoot, 'scripts', 'generate-build-info.mjs')], { cwd: repoRoot });
    });
});
