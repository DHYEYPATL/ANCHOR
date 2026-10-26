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

  it('splits multi-intent capture into separate records and parses times and weekdays', () => {
    const multiInput = `Remind me to submit my AI project report tomorrow at 10 AM.
I promised Ananya I’d share my ML notes by Friday.
Running low on detergent.`;

    const drafts = extractMultipleDrafts(multiInput);
    expect(drafts).toHaveLength(3);

    // Item 1: Task with specific time tomorrow at 10 AM
    expect(drafts[0].kind).toBe('task');
    expect(drafts[0].title.toLowerCase()).toContain('submit my ai project report');
    expect(drafts[0].dueAt).toBeTruthy();
    const date0 = new Date(drafts[0].dueAt!);
    expect(date0.getHours()).toBe(10);
    expect(date0.getMinutes()).toBe(0);

    // Item 2: Promise due by Friday
    expect(drafts[1].kind).toBe('promise');
    expect(drafts[1].category).toBe('Follow-up');
    expect(drafts[1].title.toLowerCase()).toContain('ananya');
    expect(drafts[1].dueAt).toBeTruthy();
    const date1 = new Date(drafts[1].dueAt!);
    expect(date1.getDay()).toBe(5); // Friday

    // Item 3: Consumable low-stock note
    expect(drafts[2].kind).toBe('consumable');
    expect(drafts[2].category).toBe('Household');
    expect(drafts[2].title.toLowerCase()).toContain('detergent');
  });

  it('splits multi-intent input even when pasted on a single line with periods', () => {
    const singleLine = 'Remind me to submit my AI project report tomorrow at 10 AM. I promised Ananya I’d share my ML notes by Friday. Running low on detergent.';
    const drafts = extractMultipleDrafts(singleLine);
    expect(drafts).toHaveLength(3);
    expect(drafts[0].kind).toBe('task');
    expect(drafts[1].kind).toBe('promise');
    expect(drafts[2].kind).toBe('consumable');
  });

  it('handles self-cancellation and marks item as already done with no dueAt alarm', () => {
    const input = 'Remind me to pay the electricity bill tomorrow. Actually, don\'t remind me — I already paid it.';
    const draft = extractDraft(input);
    expect(draft.isCancelled).toBe(true);
    expect(draft.status).toBe('done');
    expect(draft.dueAt).toBeUndefined();
    expect(draft.title.toLowerCase()).toContain('already completed');
  });

  it('prioritizes updated/overridden deadlines over cancelled original deadlines', () => {
    const input = 'Submit the report on Monday. My professor just changed the deadline to Wednesday. The old Monday deadline is cancelled.';
    const draft = extractDraft(input);
    expect(draft.dueAt).toBeTruthy();
    const date = new Date(draft.dueAt!);
    expect(date.getDay()).toBe(3); // Wednesday (not Monday!)
  });

  it('flags ambiguous slash dates (04/05) and bare "at 9" as unresolved without scheduling dueAt', () => {
    const input = 'Remind me about the meeting on 04/05 at 9.';
    const draft = extractDraft(input);
    expect(draft.dueAt).toBeUndefined();
    expect(draft.safetyBlocked).toBe(true);
    expect(draft.ambiguity?.isAmbiguousDate).toBe(true);
    expect(draft.ambiguity?.isAmbiguousTime).toBe(true);
    expect(draft.ambiguity?.dateOptions?.length).toBe(2);
    expect(draft.ambiguity?.timeOptions?.length).toBe(2);
    expect(draft.warning).toMatch(/ambiguity/i);
  });

  it('calculates relative offsets from specified base times (11:55 PM + 10 mins = 12:05 AM)', () => {
    const input = 'At 11:55 PM on Sunday, remind me in 10 minutes to submit my assignment.';
    const draft = extractDraft(input);
    expect(draft.dueAt).toBeTruthy();
    const date = new Date(draft.dueAt!);
    expect(date.getHours()).toBe(0); // 12 AM
    expect(date.getMinutes()).toBe(5); // :05 AM
    expect(date.getDay()).toBe(1); // Monday
  });

  it('splits multi-clause comma/conjunction separated actions into separate records', () => {
    const input = 'Pay ₹850 rent tomorrow, call Amma on Friday, buy rice and detergent, and remember that I promised Riya the notes but haven\'t agreed on a date.';
    const drafts = extractMultipleDrafts(input);
    expect(drafts.length).toBeGreaterThanOrEqual(4);
    expect(drafts[0].title.toLowerCase()).toContain('rent');
    expect(drafts[1].title.toLowerCase()).toContain('amma');
    expect(drafts[2].kind).toBe('consumable');
    expect(drafts[3].kind).toBe('promise');
  });

  it('detects clinical contradiction between conflicting dosage instructions', () => {
    const input = 'My prescription photo says 1 tablet daily. My handwritten note says 2 tablets daily. Add this medicine to my tracker.';
    const draft = extractDraft(input);
    expect(draft.warning).toContain('Clinical conflict');
    expect(draft.confidence).toBe('low');
  });

  it('calculates deterministic depletion supply and reorder notice date', () => {
    const input = 'I have 24 tablets remaining. My verified regimen is 2 tablets per day. I need 5 days\' notice to reorder.';
    const draft = extractDraft(input);
    expect(draft.kind).toBe('consumable');
    expect(draft.category).toBe('Medication');
    expect(draft.quantity).toBe(24);
    expect(draft.dailyRate).toBe(2);
    expect(draft.dueAt).toBeTruthy();
    // 24 / 2 = 12 days supply. 12 - 5 days notice = in 7 days!
    const reorderDays = Math.round((new Date(draft.dueAt!).getTime() - Date.now()) / 86400000);
    expect(reorderDays).toBeGreaterThanOrEqual(6);
    expect(reorderDays).toBeLessThanOrEqual(8);
  });

  it('parses calendar month names like January 31st', () => {
    const input = 'Create a reminder on January 31st and advance it through February';
    const draft = extractDraft(input);
    expect(draft.dueAt).toBeTruthy();
    const date = new Date(draft.dueAt!);
    expect(date.getMonth()).toBe(0); // January
    expect(date.getDate()).toBe(31);
  });
});
