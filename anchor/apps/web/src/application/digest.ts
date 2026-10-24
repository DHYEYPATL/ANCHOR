/**
 * Weekly Life Mirror & 7-Day Personal Digest.
 * Summarizes the preceding 7 days of structured records:
 * accomplishments, open promises, low stock warnings, and upcoming radar.
 * Pure deterministic functions, zero dependencies, zero cloud AI tokens.
 */

import type { AnchorItem } from '../domain/models';

export interface WeeklyLifeMirror {
  periodLabel: string;
  startDate: string;
  endDate: string;
  createdCount: number;
  completedCount: number;
  openPromisesCount: number;
  lowStockCount: number;
  highlights: string[];
  openLoops: string[];
  upcomingRadar: string[];
  lowStockItems: string[];
  reflectionText: string;
}

export function generateWeeklyLifeMirror(items: AnchorItem[], asOfDate = new Date()): WeeklyLifeMirror {
  const endMs = asOfDate.getTime();
  const startMs = endMs - 7 * 86_400_000;
  const nextWeekMs = endMs + 7 * 86_400_000;

  const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const periodLabel = `${fmt.format(new Date(startMs))} – ${fmt.format(asOfDate)}`;

  const activeItems = items.filter((i) => !i.deletedAt);

  // 1. Created in last 7 days
  const createdThisWeek = activeItems.filter((i) => {
    const t = new Date(i.createdAt).getTime();
    return t >= startMs && t <= endMs;
  });

  // 2. Completed items (status === 'done' and updated in last 7 days)
  const completedThisWeek = activeItems.filter((i) => {
    if (i.status !== 'done') return false;
    const t = new Date(i.updatedAt).getTime();
    return t >= startMs && t <= endMs;
  });

  // 3. Open promises / loops
  const openPromises = activeItems.filter((i) => i.kind === 'promise' && i.status !== 'done');

  // 4. Low stock consumables
  const lowStock = activeItems.filter((i) => {
    if (i.kind !== 'consumable' || i.status === 'done') return false;
    if (i.quantity !== undefined && (i.dailyRate ?? 0) > 0) {
      const daysLeft = Math.floor(i.quantity / i.dailyRate!);
      return daysLeft <= (i.reorderThreshold ?? 3);
    }
    return (i.quantity ?? 0) <= 2;
  });

  // 5. Coming up in next 7 days
  const upcoming = activeItems.filter((i) => {
    if (i.status === 'done' || !i.dueAt) return false;
    const due = new Date(i.dueAt).getTime();
    return due >= endMs && due <= nextWeekMs;
  });

  const highlights = completedThisWeek.slice(0, 5).map((i) => i.title);
  const openLoops = openPromises.slice(0, 5).map((i) => i.title);
  const upcomingRadar = upcoming.slice(0, 5).map((i) => `${i.title} (${fmt.format(new Date(i.dueAt!))})`);
  const lowStockItems = lowStock.slice(0, 5).map((i) => `${i.title} (${i.quantity ?? 0} ${i.unit || 'units'} left)`);

  // Phrased reflection text
  const completionSentence = completedThisWeek.length > 0
    ? `You completed ${completedThisWeek.length} item${completedThisWeek.length === 1 ? '' : 's'} this week, including “${completedThisWeek[0].title}”.`
    : `You captured ${createdThisWeek.length} new thought${createdThisWeek.length === 1 ? '' : 's'} this week.`;

  const promiseSentence = openPromises.length > 0
    ? `There ${openPromises.length === 1 ? 'is' : 'are'} ${openPromises.length} active open loop${openPromises.length === 1 ? '' : 's'} awaiting follow-up.`
    : 'All open loops and promises are clear.';

  const radarSentence = upcoming.length > 0
    ? `Coming up next: ${upcoming.length} scheduled deadline${upcoming.length === 1 ? '' : 's'}.`
    : 'Your calendar is calm with no urgent deadlines ahead.';

  const reflectionText = `${completionSentence} ${promiseSentence} ${radarSentence}`.trim();

  return {
    periodLabel,
    startDate: new Date(startMs).toISOString(),
    endDate: asOfDate.toISOString(),
    createdCount: createdThisWeek.length,
    completedCount: completedThisWeek.length,
    openPromisesCount: openPromises.length,
    lowStockCount: lowStock.length,
    highlights,
    openLoops,
    upcomingRadar,
    lowStockItems,
    reflectionText,
  };
}
