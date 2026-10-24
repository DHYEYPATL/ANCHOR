import { describe, expect, it } from 'vitest';
import { extractDraft, extractMultipleDrafts, isDueToday, isOverdue, toItemDraft } from './extractor';

describe('rule-based capture extraction', () => {
  it('extracts a task due tomorrow without depending on an LLM', () => {
    const result = extractDraft('Remind me to send the project update tomorrow');
    expect(result.kind).toBe('task');
    expect(result.title.toLowerCase()).toContain('send the project update');
    expect(result.dueAt).toBeTruthy();
    expect(new Date(result.dueAt!).getDate()).toBe(new Date(Date.now() + 86400000).getDate());
    expect(result.sourceText).toContain('tomorrow');
  });

  it('recognizes promises and household inventory hints', () => {
    expect(extractDraft('I promised Mira I would share the notes next Monday').kind).toBe('promise');
    const inventory = extractDraft('Running low on detergent, restock in 3 days');
    expect(inventory.kind).toBe('consumable');
    expect(inventory.dueAt).toBeTruthy();
  });

  it('does not invent a date if none is present', () => {
    const result = extractDraft('Review the research papers');
    expect(result.dueAt).toBeUndefined();
    expect(result.confidence).toBe('low');
  });

  it('rejects empty and oversized input', () => {
    expect(() => extractDraft('  ')).toThrow(/first/i);
    expect(() => extractDraft('x'.repeat(20_001))).toThrow(/20,000/i);
  });

  it('creates a record draft that retains the source text', () => {
    const source = 'Remember that the spare key is in the top drawer.';
    const draft = toItemDraft(extractDraft(source));
    expect(draft.sourceText).toBe(source);
    expect(draft.body).toBe(source);
  });

  it('recognizes valid date helpers and overdue status', () => {
    expect(isDueToday(new Date().toISOString())).toBe(true);
    expect(isOverdue(new Date(Date.now() - 86400000).toISOString())).toBe(true);
  });

  it('extracts multiple records from a timetable or circular list', () => {
    const timetable = `Weekly Schedule:
- Math exam tomorrow
- Submit history paper in 3 days
- Team sync next Monday`;

    const drafts = extractMultipleDrafts(timetable);
    expect(drafts).toHaveLength(3);
    expect(drafts[0].title.toLowerCase()).toContain('math exam');
    expect(drafts[0].dueAt).toBeTruthy();
    expect(drafts[1].title.toLowerCase()).toContain('submit history paper');
    expect(drafts[2].title.toLowerCase()).toContain('team sync');
  });
});
