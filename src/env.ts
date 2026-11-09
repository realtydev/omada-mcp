import { existsSync } from 'node:fs';

import { config } from 'dotenv';

// quiet: dotenv 17 logs a banner to stdout by default, which corrupts the MCP stdio transport.

// A managed runtime selects one credential file and skips cwd-based overrides.
if (process.env.OMADA_ENV_FILE) {
    config({ path: process.env.OMADA_ENV_FILE, quiet: true });
} else {
    config({ path: '.env', quiet: true });
    if (existsSync('.env.local')) {
        config({ path: '.env.local', override: true, quiet: true });
    }
}
