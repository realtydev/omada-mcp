export interface WriteVerification<T> {
    status: 'verified' | 'mismatch' | 'unknown';
    attempts: number;
    observed?: T;
    message?: string;
}

/** Re-read state after a mutation without replaying the mutation itself. */
export async function verifyWrite<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<WriteVerification<T>> {
    let observed: T | undefined;
    let readFailed = false;
    let message: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            observed = await read();
            if (matches(observed)) {
                return { status: 'verified', attempts: attempt, observed };
            }
        } catch (error) {
            readFailed = true;
            message = error instanceof Error ? error.message : String(error);
        }
        if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    return { status: readFailed ? 'unknown' : 'mismatch', attempts: 3, observed, message };
}
