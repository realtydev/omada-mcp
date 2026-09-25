import { existsSync } from 'node:fs';

import { config } from 'dotenv';

// quiet: dotenv 17 logs a banner to stdout by default, which corrupts the MCP stdio transport.

// Load .env first (base config)
config({ path: '.env', quiet: true });

// Load .env.local if it exists (overrides)
if (existsSync('.env.local')) {
    config({ path: '.env.local', override: true, quiet: true });
}
