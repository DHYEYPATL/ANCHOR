export interface StorageQuotaInfo {
  usedBytes: number;
  quotaBytes: number;
  percentUsed: number;
  isPersisted: boolean;
}

/**
 * Requests durable browser storage persistence via navigator.storage.persist().
 * Protects local IndexedDB vault from browser eviction under storage pressure.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.persist === 'function') {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Estimates currently used and total available storage quota.
 */
export async function getStorageQuotaEstimate(): Promise<StorageQuotaInfo> {
  let isPersisted = false;
  if (typeof navigator !== 'undefined' && navigator.storage) {
    if (typeof navigator.storage.persisted === 'function') {
      try {
        isPersisted = await navigator.storage.persisted();
      } catch {
        isPersisted = false;
      }
    }
    if (typeof navigator.storage.estimate === 'function') {
      try {
        const est = await navigator.storage.estimate();
        const usage = est.usage ?? 0;
        const quota = est.quota ?? (50 * 1024 * 1024);
        const percent = quota > 0 ? Math.min(100, Math.round((usage / quota) * 100)) : 0;
        return { usedBytes: usage, quotaBytes: quota, percentUsed: percent, isPersisted };
      } catch {
        // Fallback below
      }
    }
  }
  return { usedBytes: 0, quotaBytes: 50 * 1024 * 1024, percentUsed: 0, isPersisted };
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
