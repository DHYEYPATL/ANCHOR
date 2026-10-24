import { describe, expect, it } from 'vitest';
import { generateDemoSeedItems } from './demoSeed';
import { calculateAdherenceRate, generateDoctorVisitBrief } from '../domain/medication';
import { generateWeeklyLifeMirror } from './digest';

describe('demoSeed generator', () => {
  it('generates a complete 7-day seeded dataset for demonstrations', () => {
    const items = generateDemoSeedItems();
    expect(items.length).toBeGreaterThanOrEqual(8);

    // Verify medication item has adherence calculation
    const med = items.find((i) => i.id === 'demo-med-metformin')!;
    expect(med).toBeDefined();
    const adherence = calculateAdherenceRate(med);
    expect(adherence.total).toBe(7);
    expect(adherence.taken).toBe(6);
    expect(adherence.skipped).toBe(1);
    expect(adherence.ratePercent).toBe(86);

    // Verify doctor visit brief generation
    const brief = generateDoctorVisitBrief(items);
    expect(brief).toContain('Doctor-Visit Pre-Visit Brief');
    expect(brief).toContain('Metformin');
    expect(brief).toContain('86%');

    // Verify weekly life mirror generation
    const mirror = generateWeeklyLifeMirror(items);
    expect(mirror.highlights.length).toBeGreaterThanOrEqual(2);
    expect(mirror.openLoops.length).toBeGreaterThanOrEqual(1);
    expect(mirror.reflectionText).toContain('You completed');
  });
});
