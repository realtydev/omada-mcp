import type { GatewayWanStatus } from '../types/index.js';

export interface WanGuardClient {
    getGatewayWanStatus(gatewayMac: string, siteId?: string): Promise<GatewayWanStatus[]>;
    setGatewayWanConnect(gatewayMac: string, portId: number, action: 'connect' | 'disconnect', siteId?: string): Promise<unknown>;
}

export interface WanFailoverGuardOptions {
    gatewayMac: string;
    primaryPort: number;
    fallbackCidrs: string[];
    failureThreshold: number;
    dryRun: boolean;
    siteId?: string;
}

export type WanGuardAction = 'healthy' | 'observed_fallback' | 'would_disconnect' | 'disconnected' | 'already_disconnected' | 'target_missing';

export interface WanGuardResult {
    action: WanGuardAction;
    ip?: string;
    consecutiveFallbacks: number;
}

function ipv4ToNumber(ip: string): number | undefined {
    const parts = ip.split('.');
    if (parts.length !== 4) return undefined;

    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return undefined;
        const octet = Number(part);
        if (octet < 0 || octet > 255) return undefined;
        value = (value * 256 + octet) >>> 0;
    }
    return value;
}

export function isIpv4InCidr(ip: string, cidr: string): boolean {
    const [networkAddress, prefixText] = cidr.split('/');
    if (!networkAddress || prefixText === undefined || !/^\d{1,2}$/.test(prefixText)) return false;

    const address = ipv4ToNumber(ip);
    const network = ipv4ToNumber(networkAddress);
    const prefix = Number(prefixText);
    if (address === undefined || network === undefined || prefix < 0 || prefix > 32) return false;

    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) === (network & mask);
}

export function getWanIpv4Address(status: GatewayWanStatus): string | undefined {
    return status.ip?.trim() || status.wanPortIpv4Config?.addr?.trim() || status.wanPortIpv4Config?.ip?.trim() || undefined;
}

export class WanFailoverGuard {
    private consecutiveFallbacks = 0;

    constructor(
        private readonly client: WanGuardClient,
        private readonly options: WanFailoverGuardOptions
    ) {}

    public async checkOnce(): Promise<WanGuardResult> {
        const statuses = await this.client.getGatewayWanStatus(this.options.gatewayMac, this.options.siteId);
        const primary = statuses.find((status) => status.port === this.options.primaryPort);

        if (!primary) {
            this.consecutiveFallbacks = 0;
            return { action: 'target_missing', consecutiveFallbacks: 0 };
        }

        const ip = getWanIpv4Address(primary);
        if (primary.status === 0) {
            this.consecutiveFallbacks = 0;
            return { action: 'already_disconnected', ip, consecutiveFallbacks: 0 };
        }

        const isFallback = Boolean(ip && this.options.fallbackCidrs.some((cidr) => isIpv4InCidr(ip, cidr)));

        if (!isFallback) {
            this.consecutiveFallbacks = 0;
            return { action: 'healthy', ip, consecutiveFallbacks: 0 };
        }

        this.consecutiveFallbacks += 1;
        if (this.consecutiveFallbacks < this.options.failureThreshold) {
            return { action: 'observed_fallback', ip, consecutiveFallbacks: this.consecutiveFallbacks };
        }

        if (this.options.dryRun) {
            return { action: 'would_disconnect', ip, consecutiveFallbacks: this.consecutiveFallbacks };
        }

        await this.client.setGatewayWanConnect(this.options.gatewayMac, this.options.primaryPort, 'disconnect', this.options.siteId);
        this.consecutiveFallbacks = 0;
        return { action: 'disconnected', ip, consecutiveFallbacks: 0 };
    }
}
