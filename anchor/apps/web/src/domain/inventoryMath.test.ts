import { describe, expect, it } from 'vitest';
import { calculateDepletion } from './inventoryMath';

describe('Inventory & Medication Depletion Math', () => {
  it('calculates accurate depletion and reorder dates for regular supply', () => {
    const fixedNow = new Date('2026-10-25T10:00:00.000Z');
    // 30 pills, 2 pills per day -> 15 days supply. Lead time: 3 days.
    const result = calculateDepletion(30, 2, 3, fixedNow);

    expect(result).not.toBeNull();
    expect(result!.daysRemaining).toBe(15);
    expect(result!.isLow).toBe(false);
    expect(result!.runOutDate).toBe(new Date('2026-11-09T10:00:00.000Z').toISOString());
    expect(result!.reorderDate).toBe(new Date('2026-11-06T10:00:00.000Z').toISOString());
  });

  it('identifies low stock when supply is within lead time', () => {
    const fixedNow = new Date('2026-10-25T10:00:00.000Z');
    // 4 pills, 2 pills per day -> 2 days supply. Lead time: 3 days.
    const result = calculateDepletion(4, 2, 3, fixedNow);

    expect(result).not.toBeNull();
    expect(result!.daysRemaining).toBe(2);
    expect(result!.isLow).toBe(true);
    expect(result!.summary).toContain('Low stock');
  });

  it('handles zero or invalid input safely', () => {
    expect(calculateDepletion(0, 1)).not.toBeNull();
    expect(calculateDepletion(0, 1)!.daysRemaining).toBe(0);
    expect(calculateDepletion(-5, 1)).toBeNull();
    expect(calculateDepletion(10, 0)).toBeNull();
  });
});
