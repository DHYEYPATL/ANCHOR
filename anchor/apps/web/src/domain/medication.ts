/**
 * Domain workflows for medication dose tracking, adherence calculation,
 * and Doctor-Visit Pre-Visit Brief generation.
 * Pure deterministic functions, zero dependencies, zero cloud API tokens.
 */

import type { AnchorItem } from './models';
import { calculateDepletion } from './inventoryMath';

export interface DoseRecord {
  timestamp: string;
  status: 'taken' | 'skipped';
}

/**
 * Records a dose taken or skipped, updating dose history and decrementing inventory stock if taken.
 */
export function recordMedicationDose(
  item: AnchorItem,
  status: 'taken' | 'skipped',
  timestamp = new Date().toISOString(),
): AnchorItem {
  const existingLogs = item.doseLogs ?? [];
  const updatedLogs = [...existingLogs, { timestamp, status }];

  let updatedQuantity = item.quantity;
  if (status === 'taken' && updatedQuantity !== undefined && updatedQuantity > 0) {
    updatedQuantity = Math.max(0, updatedQuantity - 1);
  }

  return {
    ...item,
    quantity: updatedQuantity,
    doseLogs: updatedLogs,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Computes dose adherence rate over the preceding N days.
 */
export function calculateAdherenceRate(
  item: AnchorItem,
  days = 7,
  asOf = new Date(),
): { taken: number; skipped: number; total: number; ratePercent: number } {
  const logs = item.doseLogs ?? [];
  const cutoff = asOf.getTime() - days * 86_400_000;

  const recentLogs = logs.filter((log) => new Date(log.timestamp).getTime() >= cutoff);
  const taken = recentLogs.filter((l) => l.status === 'taken').length;
  const skipped = recentLogs.filter((l) => l.status === 'skipped').length;
  const total = taken + skipped;
  const ratePercent = total > 0 ? Math.round((taken / total) * 100) : 100;

  return { taken, skipped, total, ratePercent };
}

/**
 * Generates a clean, exportable Doctor-Visit Pre-Visit Brief.
 * Gathers confirmed medications, stock, adherence rates, and health notes.
 */
export function generateDoctorVisitBrief(items: AnchorItem[], asOf = new Date()): string {
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });
  const activeItems = items.filter((i) => !i.deletedAt);

  const medications = activeItems.filter(
    (i) => i.kind === 'consumable' && (i.category?.toLowerCase() === 'health' || i.category?.toLowerCase() === 'medication' || /pill|tablet|dose|mg|ml/i.test(i.unit || '')),
  );

  const healthNotes = activeItems.filter(
    (i) => (i.category?.toLowerCase() === 'health' || i.category?.toLowerCase() === 'medical') && i.kind !== 'consumable',
  );

  let brief = `# Doctor-Visit Pre-Visit Brief\n`;
  brief += `Generated: ${fmt.format(asOf)} · Confidential Personal Health Summary\n\n`;

  // 1. Current Medications
  brief += `## 1. Active Regimen & Medications\n`;
  if (medications.length === 0) {
    brief += `No active medications recorded in vault.\n\n`;
  } else {
    for (const med of medications) {
      const adherence = calculateAdherenceRate(med, 7, asOf);
      const stock = med.quantity !== undefined && (med.dailyRate ?? 0) > 0
        ? calculateDepletion(med.quantity, med.dailyRate!, med.reorderThreshold ?? 3, asOf)
        : null;

      brief += `### ${med.title}\n`;
      if (med.body) brief += `• Details: ${med.body}\n`;
      brief += `• Current Stock: ${med.quantity !== undefined ? `${med.quantity} ${med.unit || 'units'}` : 'Not specified'}\n`;
      if (med.dailyRate) brief += `• Prescribed Rate: ${med.dailyRate} ${med.unit || 'units'}/day\n`;
      if (stock) brief += `• Run-Out Estimate: ${stock.summary}\n`;
      brief += `• 7-Day Adherence: ${adherence.taken} taken, ${adherence.skipped} skipped (${adherence.ratePercent}%)\n\n`;
    }
  }

  // 2. Health Timeline & Recent Notes
  brief += `## 2. Health Notes & Questions for Doctor\n`;
  if (healthNotes.length === 0) {
    brief += `No symptoms or questions logged.\n\n`;
  } else {
    for (const note of healthNotes) {
      brief += `• **${note.title}**${note.body ? `: ${note.body}` : ''}\n`;
    }
    brief += `\n`;
  }

  brief += `---\n*Anchor — Local-first encrypted memory. Stored solely on user devices.*`;
  return brief;
}
