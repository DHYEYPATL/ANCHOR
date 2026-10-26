import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractDraft, extractMultipleDrafts } from './extractor';
import { assertValidAnchorItem } from '../domain/validation';
import { getDueReminderStages, getMissedReminders, acknowledgeReminder } from './reminders';
import { recordMedicationDose } from '../domain/medication';
import type { AnchorItem } from '../domain/models';

describe('Anchor 5 Production Regression Verification', () => {
  const FIXED_NOW = new Date('2026-10-25T10:00:00.000Z'); // Sunday Oct 25, 2026

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  // ==========================================
  // Test A: Ambiguous date and time
  // ==========================================
  describe('Test A: Ambiguous date and bare hour time', () => {
    const input = 'Remind me about the meeting on 04/05 at 9.';

    it('marks date and bare hour as unresolved, blocking scheduling without guessing', () => {
      const draft = extractDraft(input, FIXED_NOW);

      // Must not schedule dueAt while ambiguous
      expect(draft.dueAt).toBeUndefined();
      expect(draft.safetyBlocked).toBe(true);
      expect(draft.unresolvedReason).toMatch(/ambiguity/i);

      // Must provide explicit options for DD/MM vs MM/DD and 9 AM vs 9 PM
      expect(draft.ambiguity?.isAmbiguousDate).toBe(true);
      expect(draft.ambiguity?.dateOptions?.length).toBe(2);
      expect(draft.ambiguity?.dateOptions?.[0].label).toContain('DD/MM');
      expect(draft.ambiguity?.dateOptions?.[1].label).toContain('MM/DD');

      expect(draft.ambiguity?.isAmbiguousTime).toBe(true);
      expect(draft.ambiguity?.timeOptions?.length).toBe(2);
      expect(draft.ambiguity?.timeOptions?.some((t) => t.hour === 9)).toBe(true);
      expect(draft.ambiguity?.timeOptions?.some((t) => t.hour === 21)).toBe(true);
    });

    it('negative test: domain validation rejects saving a scheduled due date while safetyBlocked is true', () => {
      const item: AnchorItem = {
        id: '12345678-1234-4234-8234-1234567890ab',
        title: 'Meeting on 04/05 at 9',
        body: input,
        kind: 'task',
        status: 'open',
        safetyBlocked: true,
        dueAt: '2026-05-04T09:00:00.000Z', // Bypassing UI and assigning dueAt
        createdAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
        versionVector: { 'device-12345678-1234-4234-8234-1234567890ab': 1 },
      };

      expect(() => assertValidAnchorItem(item)).toThrow(/cannot schedule a due date on an item that is safety blocked/i);
    });

    it('scheduler invariant: scheduler ignores safetyBlocked items even if dueAt were populated', () => {
      const item: AnchorItem = {
        id: '12345678-1234-4234-8234-1234567890ab',
        title: 'Meeting on 04/05 at 9',
        body: 'Ambiguous meeting',
        kind: 'task',
        status: 'open',
        safetyBlocked: true,
        dueAt: new Date(Date.now() - 3600_000).toISOString(),
        createdAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
        versionVector: { 'device-12345678-1234-4234-8234-1234567890ab': 1 },
      };

      expect(getMissedReminders([item])).toHaveLength(0);
      expect(getDueReminderStages(item, Date.now())).toHaveLength(0);
    });
  });

  // ==========================================
  // Test B: Cancellation after an earlier reminder
  // ==========================================
  describe('Test B: Cancellation and negation handling', () => {
    const input = 'Remind me to pay rent tomorrow. Actually, I already paid it.';

    it('interprets the full input as a single self-cancelled memory without creating an active reminder', () => {
      // Must not split into 1 task and 1 separate memory
      const multi = extractMultipleDrafts(input, FIXED_NOW);
      expect(multi).toHaveLength(1);

      const draft = multi[0];
      expect(draft.isCancelled).toBe(true);
      expect(draft.kind).toBe('note'); // saved as memory/note
      expect(draft.dueAt).toBeUndefined(); // no alarm scheduled
      expect(draft.status).toBe('done');
      expect(draft.title.toLowerCase()).toContain('already completed');
      expect(draft.body).toBe(input); // audit trail preserved
    });

    it('scheduler does not fire alarms for cancelled/done items upon app reload or schedule rebuild', () => {
      const item: AnchorItem = {
        id: '12345678-1234-4234-8234-1234567890ab',
        title: 'Pay rent (already completed)',
        body: 'Cancelled rent note',
        kind: 'note',
        status: 'done',
        dueAt: undefined,
        createdAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
        versionVector: { 'device-12345678-1234-4234-8234-1234567890ab': 1 },
      };

      expect(getMissedReminders([item])).toHaveLength(0);
      expect(getDueReminderStages(item, Date.now())).toHaveLength(0);
    });

    it('acknowledging an existing open item cleans up notifications when cancelled', () => {
      const existingOpen: AnchorItem = {
        id: '12345678-1234-4234-8234-1234567890ab',
        title: 'Pay rent',
        body: 'Open rent reminder',
        kind: 'task',
        status: 'open',
        dueAt: new Date(Date.now() - 1000).toISOString(),
        createdAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
        versionVector: { 'device-12345678-1234-4234-8234-1234567890ab': 1 },
      };

      // Before cancellation, it shows as missed
      expect(getMissedReminders([existingOpen])).toHaveLength(1);

      // Complete and acknowledge
      acknowledgeReminder(existingOpen);
      const updatedItem: AnchorItem = { ...existingOpen, status: 'done' };

      // After cancellation, it is excluded
      expect(getMissedReminders([updatedItem])).toHaveLength(0);
    });
  });

  // ==========================================
  // Test C: Independent tasks and deadlines
  // ==========================================
  describe('Test C: Independent tasks with specific deadline overrides', () => {
    const input = 'Submit the report on Monday and pay the fee on Tuesday. The report deadline has changed to Wednesday.';

    it('produces separate records and overrides only the report deadline to Wednesday while keeping Tuesday for fee', () => {
      const drafts = extractMultipleDrafts(input, FIXED_NOW);
      expect(drafts).toHaveLength(2);

      const reportDraft = drafts.find((d) => d.title.toLowerCase().includes('report'));
      const feeDraft = drafts.find((d) => d.title.toLowerCase().includes('fee'));

      expect(reportDraft).toBeDefined();
      expect(feeDraft).toBeDefined();

      // Report must be due Wednesday (day 3)
      expect(reportDraft!.dueAt).toBeDefined();
      const reportDate = new Date(reportDraft!.dueAt!);
      expect(reportDate.getDay()).toBe(3); // Wednesday

      // Fee must be due Tuesday (day 2), NOT affected by Wednesday override
      expect(feeDraft!.dueAt).toBeDefined();
      const feeDate = new Date(feeDraft!.dueAt!);
      expect(feeDate.getDay()).toBe(2); // Tuesday
    });
  });

  // ==========================================
  // Test D: Medication dosage conflict
  // ==========================================
  describe('Test D: Medication dosage conflict safety gate', () => {
    const input = 'My prescription says 1 tablet daily. My handwritten note says 2 tablets daily.';

    it('detects conflict between 1 tablet daily and 2 tablets daily, blocking automation and marking unresolved', () => {
      const draft = extractDraft(input, FIXED_NOW);

      expect(draft.safetyBlocked).toBe(true);
      expect(draft.confidence).toBe('low');
      expect(draft.dueAt).toBeUndefined();
      expect(draft.ambiguity?.isDosageConflict).toBe(true);
      expect(draft.ambiguity?.dosageOptions).toEqual([
        { label: '1 tablet daily (Prescription)', dailyRate: 1 },
        { label: '2 tablets daily (Handwritten note)', dailyRate: 2 },
      ]);
      expect(draft.body).toContain('1 tablet daily');
      expect(draft.body).toContain('2 tablets daily');
    });

    it('negative test: dose logging is blocked for safety blocked items', () => {
      const item: AnchorItem = {
        id: '12345678-1234-4234-8234-1234567890ab',
        title: 'Medication',
        body: 'Medication body',
        kind: 'consumable',
        status: 'open',
        safetyBlocked: true,
        quantity: 30,
        createdAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
        versionVector: { 'device-12345678-1234-4234-8234-1234567890ab': 1 },
      };

      expect(() => recordMedicationDose(item, 'taken', FIXED_NOW.toISOString())).toThrow(/cannot log dose for a medication with unresolved/i);
    });

    it('negative test: domain validation rejects saving dailyRate or quantity on safetyBlocked items', () => {
      const item: AnchorItem = {
        id: '12345678-1234-4234-8234-1234567890ab',
        title: 'Medication',
        body: 'Medication body',
        kind: 'consumable',
        status: 'open',
        safetyBlocked: true,
        dailyRate: 2,
        createdAt: FIXED_NOW.toISOString(),
        updatedAt: FIXED_NOW.toISOString(),
        versionVector: { 'device-12345678-1234-4234-8234-1234567890ab': 1 },
      };

      expect(() => assertValidAnchorItem(item)).toThrow(/cannot activate dosage or inventory schedule on a safety blocked item/i);
    });
  });

  // ==========================================
  // Test E: Duplicate detection with changed deadline
  // ==========================================
  describe('Test E: Duplicate detection with changed deadline', () => {
    it('detects duplicate matching normalized intent even when the new deadline differs', () => {
      const existingItems: AnchorItem[] = [
        {
          id: '12345678-1234-4234-8234-1234567890ab',
          title: 'Submit my report',
          body: 'Original report note',
          kind: 'task',
          status: 'open',
          dueAt: '2026-10-30T09:00:00.000Z', // Friday Oct 30
          createdAt: FIXED_NOW.toISOString(),
          updatedAt: FIXED_NOW.toISOString(),
          versionVector: { 'device-12345678-1234-4234-8234-1234567890ab': 1 },
        },
      ];

      const newDraft = extractDraft('Remind me to submit my report on Monday.', FIXED_NOW);

      // Normalized title matching
      const targetNorm = newDraft.title.trim().toLowerCase().replace(/^(?:remind me to|please|todo:)\s+/i, '').replace(/[^a-z0-9]/g, '');
      const match = existingItems.find((item) => {
        if (item.status === 'done' || item.deletedAt) return false;
        const itemNorm = item.title.trim().toLowerCase().replace(/^(?:remind me to|please|todo:)\s+/i, '').replace(/[^a-z0-9]/g, '');
        return itemNorm === targetNorm || itemNorm.includes(targetNorm) || targetNorm.includes(itemNorm);
      });

      expect(match).toBeDefined();
      expect(match!.id).toBe(existingItems[0].id);

      // Verify that deadline has changed
      const isDateChanged = Boolean(newDraft.dueAt && match!.dueAt && new Date(newDraft.dueAt).toDateString() !== new Date(match!.dueAt).toDateString());
      expect(isDateChanged).toBe(true);

      // If approved update: update existing item with new dueAt and clear old notifications
      acknowledgeReminder(match!);
      const updatedItem: AnchorItem = {
        ...match!,
        dueAt: newDraft.dueAt,
        updatedAt: FIXED_NOW.toISOString(),
      };

      const updatedDate = new Date(updatedItem.dueAt!);
      expect(updatedDate.getDay()).toBe(1); // Monday
    });
  });

  // ==========================================
  // Test F: Impossible calendar date (Feb 30)
  // ==========================================
  describe('Test F: Impossible calendar date detection', () => {
    it('detects February 30 as an impossible calendar date and safety-blocks scheduling without rolling over to March', () => {
      const draft = extractDraft('Remind me to renew my ID on February 30', FIXED_NOW);
      expect(draft.safetyBlocked).toBe(true);
      expect(draft.dueAt).toBeUndefined();
      expect(draft.ambiguity?.isInvalidDate).toBe(true);
      expect(draft.ambiguity?.invalidReason).toMatch(/February.*30/i);
      expect(draft.confidence).toBe('low');
    });
  });

  // ==========================================
  // Test G: Ambiguous midnight scheduling
  // ==========================================
  describe('Test G: Ambiguous midnight scheduling', () => {
    it('prompts user for 11:59 PM vs 12:00 AM clarification when scheduled at midnight', () => {
      const draft = extractDraft('Remind me to submit the form tomorrow at midnight', FIXED_NOW);
      expect(draft.safetyBlocked).toBe(true);
      expect(draft.ambiguity?.isAmbiguousTime).toBe(true);
      expect(draft.ambiguity?.timeOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: expect.stringMatching(/11:59 PM/i) }),
          expect.objectContaining({ label: expect.stringMatching(/12:00 AM/i) }),
        ])
      );
    });
  });

  // ==========================================
  // Test H: Standalone relative offsets (in 45 minutes)
  // ==========================================
  describe('Test H: Standalone relative offsets', () => {
    it('schedules relative offset in 45 minutes calculated from current time', () => {
      const draft = extractDraft('Remind me to call the dentist in 45 minutes', FIXED_NOW);
      expect(draft.safetyBlocked).toBe(false);
      expect(draft.dueAt).toBeDefined();
      const expectedTime = new Date(FIXED_NOW.getTime() + 45 * 60 * 1000).toISOString();
      expect(draft.dueAt).toBe(expectedTime);
    });
  });

  // ==========================================
  // Test I: Reschedule correction followup sentence
  // ==========================================
  describe('Test I: Reschedule correction followup sentence', () => {
    it('keeps multi-sentence correction as a single draft and schedules for the corrected day', () => {
      const drafts = extractMultipleDrafts('Remind me to finish my assignment Friday. Actually, move it to Saturday.', FIXED_NOW);
      expect(drafts).toHaveLength(1);
      const draft = drafts[0];
      expect(draft.dueAt).toBeDefined();
      const dueDate = new Date(draft.dueAt!);
      expect(dueDate.getDay()).toBe(6); // Saturday
    });
  });

  // ==========================================
  // Test J: Cancellation detection for active tasks
  // ==========================================
  describe('Test J: Task cancellation intent matching', () => {
    it('flags cancellation intent for matching active task', () => {
      const draft = extractDraft('I no longer need to submit the assignment', FIXED_NOW);
      expect(draft.isCancelled).toBe(true);
      expect(draft.title.toLowerCase()).toContain('submit');
    });
  });

  // ==========================================
  // Test K: Confidential credentials and locker codes
  // ==========================================
  describe('Test K: Confidential secrets and locker code protection', () => {
    it('classifies locker codes as Confidential and masks secret in title', () => {
      const draft = extractDraft('Remember that my locker code is 1234.', FIXED_NOW);
      expect(draft.category).toBe('Confidential');
      expect(draft.title).toContain('••••');
      expect(draft.title).not.toContain('1234');
      // Body still contains the full record securely
      expect(draft.body).toContain('1234');
    });
  });
});

