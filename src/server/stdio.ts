import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { EnvironmentConfig } from '../config.js';
import type { OmadaClient } from '../omadaClient/index.js';
import { logger } from '../utils/logger.js';

import { createServer } from './common.js';

export async function startStdioServer(client: OmadaClient, options: Pick<EnvironmentConfig, 'toolProfile'> = {}): Promise<void> {
    logger.info('Starting stdio server');
    const server = createServer(client, options);
    const transport = new StdioServerTransport();
    logger.info('Connecting stdio server');
    await server.connect(transport);
    logger.info('Stdio server connected');
}
