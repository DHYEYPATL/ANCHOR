import { describe, expect, it } from 'vitest';
import { answerMemoryQuery } from './memoryQA';
import type { AnchorItem } from '../domain/models';

describe('Memory Q&A & Intent Router', () => {
  const sampleItems: AnchorItem[] = [
    {
      id: 'task-1',
      title: 'Pay rent',
      body: 'Transfer before 5pm',
      kind: 'task',
      status: 'open',
      confidence: 'high',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dueAt: new Date(Date.now() - 3600000).toISOString(), // overdue
      versionVector: { d: 1 },
    },
    {
      id: 'consumable-1',
      title: 'Vitamin D3',
      body: 'Take 1 pill daily',
      kind: 'consumable',
      status: 'open',
      quantity: 1,
      unit: 'bottle',
      confidence: 'high',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versionVector: { d: 1 },
    },
    {
      id: 'promise-1',
      title: 'Send budget draft to Alex',
      body: 'I promised to send this',
      kind: 'promise',
      status: 'open',
      confidence: 'high',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versionVector: { d: 1 },
    },
  ];

  it('accurately routes "What am I low on?" to inventory intent', () => {
    const res = answerMemoryQuery('What am I running low on?', sampleItems);
    expect(res.intent).toBe('inventory_low');
    expect(res.matchedItems.some((i) => i.title === 'Vitamin D3')).toBe(true);
  });

  it('accurately routes "What did I promise?" to promises intent', () => {
    const res = answerMemoryQuery('What did I promise?', sampleItems);
    expect(res.intent).toBe('promises');
    expect(res.matchedItems.some((i) => i.title.includes('Alex'))).toBe(true);
  });

  it('accurately routes "What should I do next?" to priority next_action intent', () => {
    const res = answerMemoryQuery('What should I do next?', sampleItems);
    expect(res.intent).toBe('next_action');
    // Overdue task "Pay rent" must be top priority
    expect(res.matchedItems[0].title).toBe('Pay rent');
    expect(res.headline).toContain('Pay rent');
  });

  it('accurately routes "What is due?" to due dates intent', () => {
    const res = answerMemoryQuery('What is due today?', sampleItems);
    expect(res.intent).toBe('due');
    expect(res.matchedItems.some((i) => i.title === 'Pay rent')).toBe(true);
  });
});
