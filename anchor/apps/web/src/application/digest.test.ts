import { describe, expect, it } from 'vitest';
import { generateWeeklyLifeMirror } from './digest';
import type { AnchorItem } from '../domain/models';

describe('Weekly Life Mirror (7-Day Digest)', () => {
  const now = new Date('2026-10-25T12:00:00Z');

  const sampleItems: AnchorItem[] = [
    {
      id: 'item-1',
      title: 'Finish biology report',
      body: '',
      kind: 'task',
      status: 'done',
      createdAt: '2026-10-20T10:00:00Z',
      updatedAt: '2026-10-22T15:00:00Z',
      versionVector: {},
    },
    {
      id: 'item-2',
      title: 'Promised Alex to send meeting notes',
      body: '',
      kind: 'promise',
      status: 'open',
      createdAt: '2026-10-21T09:00:00Z',
      updatedAt: '2026-10-21T09:00:00Z',
      versionVector: {},
    },
    {
      id: 'item-3',
      title: 'Vitamin D3 tablets',
      body: '',
      kind: 'consumable',
      status: 'open',
      quantity: 2,
      dailyRate: 1,
      reorderThreshold: 3,
      createdAt: '2026-10-18T08:00:00Z',
      updatedAt: '2026-10-18T08:00:00Z',
      versionVector: {},
    },
    {
      id: 'item-4',
      title: 'Dentist checkup',
      body: '',
      kind: 'event',
      status: 'open',
      dueAt: '2026-10-28T14:00:00Z',
      createdAt: '2026-10-19T08:00:00Z',
      updatedAt: '2026-10-19T08:00:00Z',
      versionVector: {},
    },
  ];

  it('summarizes weekly completed tasks and highlights', () => {
    const mirror = generateWeeklyLifeMirror(sampleItems, now);
    expect(mirror.completedCount).toBe(1);
    expect(mirror.highlights).toContain('Finish biology report');
  });

  it('identifies open promises and follow-ups', () => {
    const mirror = generateWeeklyLifeMirror(sampleItems, now);
    expect(mirror.openPromisesCount).toBe(1);
    expect(mirror.openLoops).toContain('Promised Alex to send meeting notes');
  });

  it('flags low stock inventory items', () => {
    const mirror = generateWeeklyLifeMirror(sampleItems, now);
    expect(mirror.lowStockCount).toBe(1);
    expect(mirror.lowStockItems[0]).toContain('Vitamin D3 tablets');
  });

  it('projects upcoming radar for the next seven days', () => {
    const mirror = generateWeeklyLifeMirror(sampleItems, now);
    expect(mirror.upcomingRadar[0]).toContain('Dentist checkup');
    expect(mirror.reflectionText).toContain('Finish biology report');
  });
});
