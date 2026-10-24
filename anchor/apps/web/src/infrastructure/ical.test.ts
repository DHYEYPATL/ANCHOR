import { describe, expect, it } from 'vitest';
import { generateIcs } from './ical';
import type { AnchorItem } from '../domain/models';

describe('iCalendar generator', () => {
  it('generates valid RFC 5545 iCalendar content', () => {
    const items: AnchorItem[] = [
      {
        id: 'item-1',
        title: 'Doctor Appointment',
        body: 'Bring blood test report',
        kind: 'event',
        status: 'open',
        confidence: 'high',
        createdAt: '2026-10-25T10:00:00.000Z',
        updatedAt: '2026-10-25T10:00:00.000Z',
        dueAt: '2026-10-28T14:30:00.000Z',
        category: 'Health',
        versionVector: { 'dev-1': 1 },
      },
    ];

    const ics = generateIcs(items);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('SUMMARY:Doctor Appointment');
    expect(ics).toContain('DESCRIPTION:Bring blood test report');
    expect(ics).toContain('DTSTART:20261028T143000Z');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('END:VCALENDAR');
  });
});
