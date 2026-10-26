import type { AnchorItem } from '../domain/models';
import { playReminderChime } from './sound';

const NOTIFIED_KEY_PREFIX = 'anchor-notified-reminders';

function getStoredNotifiedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY_PREFIX);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function storeNotifiedId(id: string): void {
  try {
    const current = getStoredNotifiedIds();
    current.add(id);
    // Keep set bounded to latest 500
    const list = Array.from(current).slice(-500);
    localStorage.setItem(NOTIFIED_KEY_PREFIX, JSON.stringify(list));
  } catch {
    // LocalStorage quota or restricted
  }
}

/**
 * Returns items that were due in the past (up to 7 days ago) which have not yet been completed,
 * deleted, or acknowledged by the user.
 */
export function getMissedReminders(items: AnchorItem[]): AnchorItem[] {
  const now = Date.now();
  const maxLookback = now - 7 * 24 * 60 * 60 * 1000;
  const notified = getStoredNotifiedIds();

  return items.filter((item) => {
    if (item.status === 'done' || item.deletedAt || !item.dueAt || item.safetyBlocked) return false;
    const dueTime = new Date(item.dueAt).getTime();
    if (Number.isNaN(dueTime)) return false;
    // Item is overdue and hasn't been acknowledged/notified
    return dueTime < now && dueTime >= maxLookback && !notified.has(`${item.id}:${item.dueAt}`);
  });
}

/**
 * Marks a reminder notification as seen/acknowledged so it doesn't pop up again unless rescheduled.
 */
export function acknowledgeReminder(item: AnchorItem, customKey?: string): void {
  if (customKey) {
    storeNotifiedId(customKey);
  } else if (item.dueAt) {
    storeNotifiedId(`${item.id}:${item.dueAt}`);
  }
}

/**
 * Calculates a new ISO date string snoozed by the given number of minutes.
 */
export function calculateSnoozedDueAt(minutes: number): string {
  const date = new Date(Date.now() + minutes * 60 * 1000);
  return date.toISOString();
}

export type ReminderStage = '1week' | '1day' | '1hour' | 'lead' | 'due';

export interface DueReminderStage {
  stage: ReminderStage;
  label: string;
  stageKey: string;
}

/**
 * Detects whether any multistage reminders (1 week, 1 day, 1 hour, custom lead time, or due time)
 * should fire for this item right now.
 */
export function getDueReminderStages(item: AnchorItem, now = Date.now()): DueReminderStage[] {
  if (item.status === 'done' || item.deletedAt || !item.dueAt || item.safetyBlocked) return [];
  const dueTime = new Date(item.dueAt).getTime();
  if (Number.isNaN(dueTime)) return [];

  const results: DueReminderStage[] = [];
  const isTargetNow = (targetMs: number) => targetMs <= now && targetMs > now - 120_000;

  // 1. Configured lead buffer (reminderMinutesBefore)
  if (item.reminderMinutesBefore && item.reminderMinutesBefore > 0) {
    const leadMs = item.reminderMinutesBefore * 60 * 1000;
    if (isTargetNow(dueTime - leadMs)) {
      results.push({
        stage: 'lead',
        label: `Reminder (${item.reminderMinutesBefore}m before)`,
        stageKey: `${item.id}:${item.dueAt}:lead`,
      });
    }
  }

  // 2. 1 week before
  if (isTargetNow(dueTime - 7 * 86_400_000)) {
    results.push({
      stage: '1week',
      label: 'Upcoming in 1 week',
      stageKey: `${item.id}:${item.dueAt}:1week`,
    });
  }

  // 3. 1 day before
  if (isTargetNow(dueTime - 86_400_000)) {
    results.push({
      stage: '1day',
      label: 'Upcoming tomorrow',
      stageKey: `${item.id}:${item.dueAt}:1day`,
    });
  }

  // 4. 1 hour before
  if (isTargetNow(dueTime - 3_600_000)) {
    results.push({
      stage: '1hour',
      label: 'Upcoming in 1 hour',
      stageKey: `${item.id}:${item.dueAt}:1hour`,
    });
  }

  // 5. At due time
  if (isTargetNow(dueTime)) {
    results.push({
      stage: 'due',
      label: 'Due now',
      stageKey: `${item.id}:${item.dueAt}:due`,
    });
  }

  return results;
}

/**
 * Calculates the next occurrence date for recurring items.
 * Robust edge-case handling for month-end dates and leap years.
 */
export function computeNextRecurrence(
  currentDueAt: string,
  recurrence: 'daily' | 'weekly' | 'monthly' | 'yearly',
): string {
  const current = new Date(currentDueAt);
  if (Number.isNaN(current.getTime())) return currentDueAt;

  const next = new Date(current);

  if (recurrence === 'daily') {
    next.setUTCDate(next.getUTCDate() + 1);
  } else if (recurrence === 'weekly') {
    next.setUTCDate(next.getUTCDate() + 7);
  } else if (recurrence === 'monthly') {
    const targetDay = current.getUTCDate();
    const nextMonth = current.getUTCMonth() + 1;
    const nextYear = current.getUTCFullYear() + Math.floor(nextMonth / 12);
    const normalizedMonth = nextMonth % 12;
    const maxDaysInNextMonth = new Date(Date.UTC(nextYear, normalizedMonth + 1, 0)).getUTCDate();
    next.setUTCFullYear(nextYear, normalizedMonth, Math.min(targetDay, maxDaysInNextMonth));
  } else if (recurrence === 'yearly') {
    const targetMonth = current.getUTCMonth();
    const targetDay = current.getUTCDate();
    const nextYear = current.getUTCFullYear() + 1;
    const isNextLeapYear =
      (nextYear % 4 === 0 && nextYear % 100 !== 0) || nextYear % 400 === 0;
    const finalDay = targetMonth === 1 && targetDay === 29 && !isNextLeapYear ? 28 : targetDay;
    next.setUTCFullYear(nextYear, targetMonth, finalDay);
  }

  return next.toISOString();
}

/**
 * Fires an in-app audio chime and dispatches a persistent notification via ServiceWorker if available,
 * falling back to the standard browser Notification API.
 */
export async function dispatchReminderNotification(
  item: AnchorItem,
  enableChime = true,
  stageLabel = 'Due now',
  stageKey?: string,
): Promise<boolean> {
  if (enableChime) {
    playReminderChime();
  }

  acknowledgeReminder(item, stageKey);

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return false;
  }

  const title = `${stageLabel} · ${item.title}`;
  const options: NotificationOptions = {
    body: item.body ? item.body.slice(0, 100) : 'Open Anchor to view and complete this reminder.',
    tag: `reminder-${item.id}`,
    icon: '/anchor-mark.svg',
  };

  // 1. Try Service Worker registration (native mobile/PWA background notifications)
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(title, options);
        return true;
      }
    } catch {
      // Fallback to standard window Notification
    }
  }

  // 2. Fallback to standard window Notification
  try {
    new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}
