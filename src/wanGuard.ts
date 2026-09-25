import './env.js';

import { loadConfigFromEnv } from './config.js';
import { OmadaClient } from './omadaClient/index.js';
import { initLogger, logger } from './utils/logger.js';
import { loadWanGuardConfig } from './wanGuard/config.js';
import { WanFailoverGuard } from './wanGuard/wanFailoverGuard.js';

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main(): Promise<void> {
    const clientConfig = loadConfigFromEnv();
    const guardConfig = loadWanGuardConfig();
    initLogger(clientConfig.logLevel, clientConfig.logFormat, false);

    if (!guardConfig.enabled) {
        throw new Error('WAN guard is disabled. Set OMADA_WAN_GUARD_ENABLED=true to run it.');
    }

    const client = new OmadaClient({ ...clientConfig, requestTimeout: guardConfig.requestTimeoutMs });
    const guard = new WanFailoverGuard(client, {
        gatewayMac: guardConfig.gatewayMac,
        primaryPort: guardConfig.primaryPort,
        fallbackCidrs: guardConfig.fallbackCidrs,
        failureThreshold: guardConfig.failureThreshold,
        dryRun: guardConfig.dryRun,
        siteId: clientConfig.siteId,
    });

    let stopping = false;
    let lastSummary = '';
    const stop = () => {
        stopping = true;
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    logger.info('WAN failover guard started', {
        gatewayMac: guardConfig.gatewayMac,
        primaryPort: guardConfig.primaryPort,
        fallbackCidrs: guardConfig.fallbackCidrs,
        intervalMs: guardConfig.intervalMs,
        failureThreshold: guardConfig.failureThreshold,
        requestTimeoutMs: guardConfig.requestTimeoutMs,
        dryRun: guardConfig.dryRun,
    });

    while (!stopping) {
        try {
            const result = await guard.checkOnce();
            const summary = `${result.action}:${result.ip ?? 'none'}:${result.consecutiveFallbacks}`;
            if (summary !== lastSummary || result.action === 'disconnected' || result.action === 'would_disconnect') {
                const log = result.action === 'disconnected' || result.action === 'would_disconnect' ? logger.warn : logger.info;
                log('WAN failover guard check', { ...result });
                lastSummary = summary;
            }
        } catch (error) {
            logger.error('WAN failover guard check failed; leaving WAN state unchanged', {
                error: error instanceof Error ? error.message : String(error),
            });
        }

        if (!stopping) await wait(guardConfig.intervalMs);
    }

    logger.info('WAN failover guard stopped');
}

main().catch((error) => {
    logger.error('Failed to start WAN failover guard', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
});
