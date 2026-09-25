/**
 * One client association session, normalised from the insight past-connection endpoint.
 */
export interface ClientSession {
    /** Session start, epoch milliseconds (the API's `firstSeen`) */
    start: number;

    /** Session end, epoch milliseconds (the API's `lastSeen`) */
    end: number;

    /** Session length in seconds */
    durationSeconds: number;

    /** Name of the AP (wireless) or switch (wired) the client was on */
    deviceName?: string;

    /** (Wireless) SSID name */
    ssid?: string;

    /** (Wired) Port ID */
    port?: number;

    /** (Wireless) Time in milliseconds the client took to connect to the SSID */
    associationTimeMs?: number;

    /** Downstream traffic in bytes */
    download?: number;

    /** Upstream traffic in bytes */
    upload?: number;
}

/**
 * A roam: two consecutive wireless sessions on different devices with a gap of at most `maxGapSeconds`.
 */
export interface ClientRoam {
    /** When the client appeared on the new device, epoch milliseconds */
    at: number;

    /** Device the client left */
    from: { deviceName?: string; ssid?: string; sessionEnd: number };

    /** Device the client joined */
    to: { deviceName?: string; ssid?: string; sessionStart: number };

    /** Seconds between the previous session ending and the next one starting (negative if they overlap) */
    gapSeconds: number;
}

export interface ClientHistory {
    clientMac: string;

    /** Sessions sorted oldest first */
    sessions: ClientSession[];

    /** Present only when a roam timeline was requested */
    roams?: ClientRoam[];

    /** True when the page cap was reached before the whole time range was fetched */
    truncated?: boolean;
}

/**
 * Options for fetching a client's session history.
 */
export interface GetClientHistoryOptions {
    siteId?: string;

    clientMac: string;

    /** Start of time range, epoch milliseconds (default: 7 days before timeEnd) */
    timeStart?: number;

    /** End of time range, epoch milliseconds (default: now) */
    timeEnd?: number;

    /** Also compute roams between consecutive wireless sessions */
    roamTimeline?: boolean;

    /** Largest gap in seconds between sessions that still counts as a roam (default: 60) */
    maxGapSeconds?: number;
}
