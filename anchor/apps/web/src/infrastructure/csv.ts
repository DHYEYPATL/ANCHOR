/**
 * Standard CSV Export for Anchor Items.
 * Complies with RFC 4180 standard escaping.
 * Pure deterministic functions, zero external dependencies.
 */

import type { AnchorItem } from '../domain/models';

function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function generateCsv(items: AnchorItem[]): string {
  const headers = [
    'ID',
    'Type',
    'Title',
    'Status',
    'Due Date',
    'Category',
    'Quantity',
    'Unit',
    'Daily Rate',
    'Created At',
    'Updated At',
    'Details',
  ];

  const rows = items.map((item) => [
    escapeCsvField(item.id),
    escapeCsvField(item.kind),
    escapeCsvField(item.title),
    escapeCsvField(item.status),
    escapeCsvField(item.dueAt || ''),
    escapeCsvField(item.category || ''),
    escapeCsvField(item.quantity ?? ''),
    escapeCsvField(item.unit || ''),
    escapeCsvField(item.dailyRate ?? ''),
    escapeCsvField(item.createdAt),
    escapeCsvField(item.updatedAt),
    escapeCsvField(item.body || ''),
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n');
}
