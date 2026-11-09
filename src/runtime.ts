#!/usr/bin/env node
import { runCli } from './runtime/cli.js';

runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`Omada runtime: ${error instanceof Error ? error.message : 'operation failed'}\n`);
    process.exitCode = 1;
});
