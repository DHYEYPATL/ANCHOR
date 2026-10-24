/**
 * Deterministic math for inventory and medication run-out calculations.
 * Pure functions, zero dependencies, runs 100% locally.
 */

export interface DepletionCalculation {
  daysRemaining: number;
  runOutDate: string;
  reorderDate: string;
  isLow: boolean;
  summary: string;
}

export function calculateDepletion(
  quantity: number,
  dailyUsage: number,
  leadDays = 3,
  fromDate = new Date(),
): DepletionCalculation | null {
  if (!Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(dailyUsage) || dailyUsage <= 0) {
    return null;
  }

  const daysRemaining = Math.floor(quantity / dailyUsage);
  const startMs = fromDate.getTime();
  const runOutMs = startMs + daysRemaining * 86_400_000;
  const reorderMs = Math.max(startMs, runOutMs - leadDays * 86_400_000);

  const runOutDate = new Date(runOutMs).toISOString();
  const reorderDate = new Date(reorderMs).toISOString();
  const isLow = daysRemaining <= leadDays;

  const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const runOutFormatted = dateFmt.format(new Date(runOutMs));
  const reorderFormatted = dateFmt.format(new Date(reorderMs));

  const summary = daysRemaining === 0
    ? 'Out of stock today!'
    : isLow
    ? `Low stock: ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left (runs out ${runOutFormatted}). Order now!`
    : `Supply for ~${daysRemaining} days (runs out ${runOutFormatted}). Reorder by ${reorderFormatted}.`;

  return {
    daysRemaining,
    runOutDate,
    reorderDate,
    isLow,
    summary,
  };
}
