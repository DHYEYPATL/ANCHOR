import { describe, expect, it } from 'vitest';
import { generateCsv } from './csv';
import type { AnchorItem } from '../domain/models';

describe('CSV Generator', () => {
  const sampleItems: AnchorItem[] = [
    {
      id: 'task-1',
      title: 'Buy groceries, milk & eggs',
      body: 'Need "fresh" eggs and organic milk',
      kind: 'task',
      status: 'open',
      category: 'Shopping',
      createdAt: '2026-10-25T10:00:00Z',
      updatedAt: '2026-10-25T10:00:00Z',
      versionVector: {},
    },
    {
      id: 'med-1',
      title: 'Aspirin',
      body: 'Take 1 daily',
      kind: 'consumable',
      status: 'open',
      quantity: 50,
      unit: 'pills',
      dailyRate: 1,
      createdAt: '2026-10-25T10:00:00Z',
      updatedAt: '2026-10-25T10:00:00Z',
      versionVector: {},
    },
  ];

  it('generates standard RFC 4180 CSV headers and rows', () => {
    const csv = generateCsv(sampleItems);
    expect(csv).toContain('ID,Type,Title,Status,Due Date');
    expect(csv).toContain('"Buy groceries, milk & eggs"');
    expect(csv).toContain('"Need ""fresh"" eggs and organic milk"');
    expect(csv).toContain('Aspirin');
    expect(csv).toContain('pills');
  });
});
