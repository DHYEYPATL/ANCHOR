import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  getMissedReminders,
  acknowledgeReminder,
  calculateSnoozedDueAt,
  dispatchReminderNotification,
  computeNextRecurrence,
  getDueReminderStages,
} from './reminders';
import type { AnchorItem } from '../domain/models';

describe('Reminders Management', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const baseItem: AnchorItem = {
    id: 'test-item-1',
    title: 'Pay electricity bill',
    body: 'Check online portal',
    kind: 'task',
    status: 'open',
    confidence: 'high',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    versionVector: { 'dev-1': 1 },
    dueAt: new Date(Date.now() - 3600 * 1000).toISOString(), // 1 hour ago
  };

  it('identifies overdue items as missed reminders when unacknowledged', () => {
    const missed = getMissedReminders([baseItem]);
    expect(missed).toHaveLength(1);
    expect(missed[0].id).toBe('test-item-1');
  });

  it('excludes done or deleted items from missed reminders', () => {
    const doneItem: AnchorItem = { ...baseItem, status: 'done' };
    const deletedItem: AnchorItem = { ...baseItem, deletedAt: new Date().toISOString() };

    expect(getMissedReminders([doneItem])).toHaveLength(0);
    expect(getMissedReminders([deletedItem])).toHaveLength(0);
  });

  it('excludes acknowledged reminders', () => {
    acknowledgeReminder(baseItem);
    expect(getMissedReminders([baseItem])).toHaveLength(0);
  });

  it('calculates snoozed timestamps accurately', () => {
    const before = Date.now();
    const snoozed = calculateSnoozedDueAt(60); // 60 mins
    const diff = new Date(snoozed).getTime() - before;
    expect(diff).toBeGreaterThanOrEqual(59 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(61 * 60 * 1000);
  });

  it('dispatches notifications and acknowledges reminders', async () => {
    const mockNotification = vi.fn();
    (window as unknown as Record<string, unknown>).Notification = mockNotification;
    (window as unknown as { Notification: { permission: string } }).Notification.permission = 'granted';

    const result = await dispatchReminderNotification(baseItem, false);
    expect(result).toBe(true);
    expect(mockNotification).toHaveBeenCalled();

    // Verify it is acknowledged
    expect(getMissedReminders([baseItem])).toHaveLength(0);
  });

  describe('computeNextRecurrence', () => {
    it('computes daily recurrence (+1 day)', () => {
      const date = '2026-03-15T09:00:00.000Z';
      const next = computeNextRecurrence(date, 'daily');
      expect(new Date(next).getUTCDate()).toBe(16);
    });

    it('computes weekly recurrence (+7 days)', () => {
      const date = '2026-03-15T09:00:00.000Z';
      const next = computeNextRecurrence(date, 'weekly');
      expect(new Date(next).getUTCDate()).toBe(22);
    });

    it('handles monthly recurrence with month-end clipping', () => {
      const date = '2026-01-31T09:00:00.000Z';
      const next = computeNextRecurrence(date, 'monthly');
      // 2026 is not a leap year, February has 28 days
      const d = new Date(next);
      expect(d.getUTCMonth()).toBe(1); // February (0-indexed)
      expect(d.getUTCDate()).toBe(28);
    });

    it('handles yearly recurrence with leap-day clipping', () => {
      const leapDay = '2028-02-29T09:00:00.000Z';
      const next = computeNextRecurrence(leapDay, 'yearly');
      const d = new Date(next);
      expect(d.getUTCFullYear()).toBe(2029);
      expect(d.getUTCMonth()).toBe(1);
      expect(d.getUTCDate()).toBe(28);
    });
  });

  describe('getDueReminderStages', () => {
    it('detects lead reminder stage based on reminderMinutesBefore', () => {
      const now = Date.now();
      const itemWithLead: AnchorItem = {
        ...baseItem,
        reminderMinutesBefore: 15,
        dueAt: new Date(now + 15 * 60 * 1000).toISOString(),
      };

      const stages = getDueReminderStages(itemWithLead, now);
      expect(stages.some((s) => s.stage === 'lead')).toBe(true);
    });

    it('detects 1-day advance reminder stage', () => {
      const now = Date.now();
      const itemTomorrow: AnchorItem = {
        ...baseItem,
        dueAt: new Date(now + 86_400_000).toISOString(),
      };

      const stages = getDueReminderStages(itemTomorrow, now);
      expect(stages.some((s) => s.stage === '1day')).toBe(true);
    });
  });
});
