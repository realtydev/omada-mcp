export interface GatewayWanStatus {
    port: number;
    name?: string;
    portDesc?: string;
    status?: number;
    internetState?: number;
    ip?: string;
    onlineDetection?: number;
    latency?: number;
    loss?: number;
    wanPortIpv4Config?: {
        addr?: string;
        ip?: string;
        gateway?: string;
        priDns?: string;
        sndDns?: string;
    };
}
