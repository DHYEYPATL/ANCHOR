/**
 * Generates standard RFC 5545 iCalendar (.ics) files for Anchor items.
 * Uses 0 external dependencies and standard library string manipulation.
 */

import type { AnchorItem } from '../domain/models';

function formatIcsDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function generateIcs(items: AnchorItem[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Anchor//Local Memory//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const item of items) {
    if (!item.dueAt || item.status === 'done' || item.deletedAt) continue;
    const dtStamp = formatIcsDate(item.createdAt || new Date().toISOString());
    const dtStart = formatIcsDate(item.dueAt);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${item.id}@anchor.local`);
    lines.push(`DTSTAMP:${dtStamp}`);
    lines.push(`DTSTART:${dtStart}`);
    lines.push(`SUMMARY:${item.title.replace(/[\r\n]+/g, ' ')}`);
    if (item.body) {
      lines.push(`DESCRIPTION:${item.body.replace(/\n/g, '\\n').replace(/[\r]+/g, '')}`);
    }
    if (item.category) {
      lines.push(`CATEGORIES:${item.category}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
