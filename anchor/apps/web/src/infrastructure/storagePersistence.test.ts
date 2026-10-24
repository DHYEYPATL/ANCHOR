import { describe, expect, it } from 'vitest';
import { formatBytes, getStorageQuotaEstimate, requestPersistentStorage } from './storagePersistence';

describe('storagePersistence helpers', () => {
  it('formats byte strings cleanly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('safely handles environments without navigator.storage', async () => {
    const isPersisted = await requestPersistentStorage();
    expect(typeof isPersisted).toBe('boolean');

    const estimate = await getStorageQuotaEstimate();
    expect(estimate.quotaBytes).toBeGreaterThan(0);
    expect(estimate.percentUsed).toBeGreaterThanOrEqual(0);
  });
});
