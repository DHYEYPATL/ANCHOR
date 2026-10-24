import type { AnchorItem } from '../domain/models';

/**
 * Generates a realistic, seeded 7-day demo vault dataset for demonstrating:
 * - Weekly Life Mirror
 * - Doctor Visit Brief & Medication adherence calculations
 * - Inventory Depletion warnings
 * - Memory Q&A ("What is due?", "What am I low on?", "What did I promise?")
 */
export function generateDemoSeedItems(): AnchorItem[] {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  const isoOffset = (days: number, hour = 12): string => {
    const d = new Date(now.getTime() + days * dayMs);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  // Past 7 days dose logs: 6 taken, 1 skipped -> 85.7% adherence
  const sampleDoseLogs = [
    { timestamp: isoOffset(-6, 8), status: 'taken' as const },
    { timestamp: isoOffset(-5, 8), status: 'taken' as const },
    { timestamp: isoOffset(-4, 8), status: 'taken' as const },
    { timestamp: isoOffset(-3, 8), status: 'skipped' as const },
    { timestamp: isoOffset(-2, 8), status: 'taken' as const },
    { timestamp: isoOffset(-1, 8), status: 'taken' as const },
    { timestamp: isoOffset(0, 8), status: 'taken' as const },
  ];

  return [
    // 1. Daily Prescription Medication with 7-day adherence history
    {
      id: 'demo-med-metformin',
      kind: 'consumable',
      title: 'Metformin 500mg (Daily Tablet)',
      body: 'Take 1 tablet every morning with breakfast. Doctor: Dr. Sharma.',
      category: 'Health',
      status: 'open',
      createdAt: isoOffset(-14),
      updatedAt: isoOffset(0),
      versionVector: { 'demo-device': 1 },
      quantity: 12,
      unit: 'tablets',
      dailyRate: 1,
      reorderThreshold: 5,
      doseLogs: sampleDoseLogs,
    },
    // 2. Household consumable approaching depletion (low stock alert)
    {
      id: 'demo-consumable-coffee',
      kind: 'consumable',
      title: 'Whole Bean Espresso Roast',
      body: 'Single-origin espresso beans. 1 bag left.',
      category: 'Household',
      status: 'open',
      createdAt: isoOffset(-10),
      updatedAt: isoOffset(-1),
      versionVector: { 'demo-device': 1 },
      quantity: 2,
      unit: 'bags',
      dailyRate: 1,
      reorderThreshold: 3,
    },
    // 3. Completed task in last 7 days (shows up in Weekly Life Mirror accomplishments)
    {
      id: 'demo-task-taxes',
      kind: 'task',
      title: 'Submit quarterly municipal property tax',
      body: 'Paid online via municipal portal. Receipt saved.',
      category: 'Finance',
      status: 'done',
      createdAt: isoOffset(-5),
      updatedAt: isoOffset(-2),
      versionVector: { 'demo-device': 2 },
    },
    // 4. Completed task: Doctor checkup lab bloodwork
    {
      id: 'demo-task-bloodwork',
      kind: 'task',
      title: 'Annual fasting lipid panel & HbA1c test',
      body: 'Completed at City Diagnostic Labs. Results shared with Dr. Sharma.',
      category: 'Health',
      status: 'done',
      createdAt: isoOffset(-4),
      updatedAt: isoOffset(-1),
      versionVector: { 'demo-device': 2 },
    },
    // 5. Open loop: Promise to friend/colleague
    {
      id: 'demo-promise-sarah',
      kind: 'promise',
      title: 'Return lawnmower to Sarah',
      body: 'I promised Sarah I would bring back her electric mower before Sunday.',
      category: 'Personal',
      status: 'open',
      dueAt: isoOffset(2, 17),
      createdAt: isoOffset(-3),
      updatedAt: isoOffset(-3),
      versionVector: { 'demo-device': 1 },
    },
    // 6. Upcoming event: Science fair presentation
    {
      id: 'demo-event-science-fair',
      kind: 'event',
      title: 'School Science Fair Presentation',
      body: 'Auditorium main hall. Set up display board before 9 AM.',
      category: 'Family',
      status: 'open',
      dueAt: isoOffset(3, 9),
      createdAt: isoOffset(-2),
      updatedAt: isoOffset(-2),
      versionVector: { 'demo-device': 1 },
    },
    // 7. Upcoming task: Electricity bill
    {
      id: 'demo-task-electricity',
      kind: 'task',
      title: 'Pay BESCOM electricity utility bill',
      body: 'Due by Friday to avoid disconnection warning.',
      category: 'Finance',
      status: 'open',
      dueAt: isoOffset(1, 18),
      createdAt: isoOffset(-1),
      updatedAt: isoOffset(-1),
      versionVector: { 'demo-device': 1 },
    },
    // 8. Daily log reflection from 2 days ago
    {
      id: 'demo-log-wednesday',
      kind: 'note',
      title: 'Mid-week energy & focus reflection',
      body: 'Productive morning walk. Focused on finishing the encryption key isolation. High energy throughout the afternoon.',
      category: 'Journal',
      status: 'open',
      createdAt: isoOffset(-2, 21),
      updatedAt: isoOffset(-2, 21),
      versionVector: { 'demo-device': 1 },
    },
  ];
}
