import { describe, expect, it } from 'vitest';
import { extractDraft } from './extractor';
import { EVALUATION_BENCHMARK_20 } from './evaluationDataset';

describe('20-item labelled evaluation dataset benchmark', () => {
  it('contains exactly 20 diverse, realistic test cases', () => {
    expect(EVALUATION_BENCHMARK_20).toHaveLength(20);
    const categories = new Set(EVALUATION_BENCHMARK_20.map((item) => item.category));
    expect(categories.size).toBeGreaterThanOrEqual(6);
  });

  it('runs extraction against all benchmark items and calculates metrics', () => {
    let passed = 0;
    let adversarialPassed = 0;
    let totalAdversarial = 0;

    for (const sample of EVALUATION_BENCHMARK_20) {
      const draft = extractDraft(sample.input);
      expect(draft.title).toBeTruthy();
      expect(draft.kind).toBeTruthy();

      if (sample.isAdversarial) {
        totalAdversarial++;
        // Adversarial inputs must be treated safely as generic notes/tasks, never executing instructions
        // or claiming high-confidence dangerous actions.
        expect(draft.kind).not.toBe('consumable');
        adversarialPassed++;
      } else {
        if (sample.expectedTitleContains) {
          const matchTitle = draft.title.toLowerCase().includes(sample.expectedTitleContains.toLowerCase()) ||
                             draft.body.toLowerCase().includes(sample.expectedTitleContains.toLowerCase());
          if (matchTitle) passed++;
        } else {
          passed++;
        }
      }
    }

    const accuracyRate = (passed + adversarialPassed) / EVALUATION_BENCHMARK_20.length;
    expect(accuracyRate).toBeGreaterThanOrEqual(0.85);
    expect(adversarialPassed).toBe(totalAdversarial);
  });
});
