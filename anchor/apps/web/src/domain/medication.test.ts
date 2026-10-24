import { describe, expect, it } from 'vitest';
import { recordMedicationDose, calculateAdherenceRate, generateDoctorVisitBrief } from './medication';
import type { AnchorItem } from './models';

describe('Medication Dose Tracking & Doctor-Visit Brief', () => {
  const sampleMed: AnchorItem = {
    id: 'med-1',
    title: 'Metformin 500mg',
    body: 'Take 1 with dinner',
    kind: 'consumable',
    category: 'Medication',
    status: 'open',
    quantity: 30,
    unit: 'tablets',
    dailyRate: 1,
    reorderThreshold: 5,
    createdAt: '2026-10-01T08:00:00Z',
    updatedAt: '2026-10-01T08:00:00Z',
    versionVector: {},
  };

  it('records a dose taken and decrements stock', () => {
    const updated = recordMedicationDose(sampleMed, 'taken');
    expect(updated.quantity).toBe(29);
    expect(updated.doseLogs).toHaveLength(1);
    expect(updated.doseLogs?.[0].status).toBe('taken');
  });

  it('records a dose skipped without decrementing stock', () => {
    const updated = recordMedicationDose(sampleMed, 'skipped');
    expect(updated.quantity).toBe(30);
    expect(updated.doseLogs).toHaveLength(1);
    expect(updated.doseLogs?.[0].status).toBe('skipped');
  });

  it('calculates adherence rate correctly over 7 days', () => {
    let item = sampleMed;
    item = recordMedicationDose(item, 'taken', '2026-10-24T12:00:00Z');
    item = recordMedicationDose(item, 'taken', '2026-10-23T12:00:00Z');
    item = recordMedicationDose(item, 'skipped', '2026-10-22T12:00:00Z');

    const adherence = calculateAdherenceRate(item, 7, new Date('2026-10-25T12:00:00Z'));
    expect(adherence.taken).toBe(2);
    expect(adherence.skipped).toBe(1);
    expect(adherence.total).toBe(3);
    expect(adherence.ratePercent).toBe(67);
  });

  it('generates a formatted doctor-visit pre-visit brief', () => {
    const healthNote: AnchorItem = {
      id: 'note-1',
      title: 'Mild dizziness in the morning',
      body: 'Started 2 days ago after breakfast',
      kind: 'note',
      category: 'Health',
      status: 'open',
      createdAt: '2026-10-24T08:00:00Z',
      updatedAt: '2026-10-24T08:00:00Z',
      versionVector: {},
    };

    const brief = generateDoctorVisitBrief([sampleMed, healthNote], new Date('2026-10-25T12:00:00Z'));
    expect(brief).toContain('Metformin 500mg');
    expect(brief).toContain('Mild dizziness in the morning');
    expect(brief).toContain('Doctor-Visit Pre-Visit Brief');
  });
});
