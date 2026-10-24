import { describe, expect, it } from 'vitest';
import { getUnlockThrottleState, recordFailedUnlock, recordSuccessfulUnlock } from './securityPolicy';

describe('securityPolicy unlock throttling', () => {
  it('applies exponential backoff on repeated failed attempts', () => {
    recordSuccessfulUnlock();
    expect(getUnlockThrottleState().failedAttempts).toBe(0);
    expect(getUnlockThrottleState().isLockedOut).toBe(false);

    recordFailedUnlock(); // 1
    recordFailedUnlock(); // 2
    expect(getUnlockThrottleState().isLockedOut).toBe(false);

    const s3 = recordFailedUnlock(); // 3 -> delay 1000ms
    expect(s3.failedAttempts).toBe(3);
    expect(s3.isLockedOut).toBe(true);
    expect(s3.remainingMs).toBeGreaterThan(0);

    recordSuccessfulUnlock();
    expect(getUnlockThrottleState().failedAttempts).toBe(0);
    expect(getUnlockThrottleState().isLockedOut).toBe(false);
  });
});
