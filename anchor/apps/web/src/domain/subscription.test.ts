import { describe, expect, it } from 'vitest';
import { getSubscriptionCancellationGuide } from './subscription';
import type { AnchorItem } from './models';

describe('subscription cancellation helper', () => {
  it('generates a step-by-step checklist for recurring services and trials', () => {
    const item: AnchorItem = {
      id: 'sub-1',
      kind: 'document',
      title: 'CloudSync Pro 14-day free trial',
      body: 'Will bill $49/year on 2026-11-05 unless canceled.',
      category: 'Subscriptions',
      status: 'open',
      dueAt: '2026-11-05T00:00:00.000Z',
      createdAt: '2026-10-22T00:00:00.000Z',
      updatedAt: '2026-10-22T00:00:00.000Z',
      versionVector: { test: 1 },
    };

    const guide = getSubscriptionCancellationGuide(item);
    expect(guide.isSubscription).toBe(true);
    expect(guide.checklist.length).toBeGreaterThanOrEqual(4);
    expect(guide.checklist[0]).toContain('account settings');
  });
});
