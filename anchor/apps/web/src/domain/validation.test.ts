import { describe, expect, it } from 'vitest';
import { assertValidAnchorItem } from './validation';

const validItem = () => ({
  id: '05f4e9a2-2ce5-4c42-a194-49f4ed5a22a7',
  kind: 'task', title: 'Pay bill', body: '', status: 'open',
  createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
  versionVector: { 'device-05f4e9a2-2ce5-4c42-a194-49f4ed5a22a7': 1 },
  attachments: [],
});

describe('strict record validation', () => {
  it('accepts a normal versioned record', () => {
    expect(() => assertValidAnchorItem(validItem())).not.toThrow();
  });
  it('rejects unknown fields instead of letting unversioned data spread through sync', () => {
    expect(() => assertValidAnchorItem({ ...validItem(), unexpected: 'value' })).toThrow(/unsupported field/i);
  });
  it('rejects calendar-invalid dates that JavaScript might normalize', () => {
    expect(() => assertValidAnchorItem({ ...validItem(), dueAt: '2026-02-31T09:00:00.000Z' })).toThrow(/due date/i);
  });
  it('rejects an invalid device identity in the version vector', () => {
    expect(() => assertValidAnchorItem({ ...validItem(), versionVector: { 'device-not-a-uuid': 1 } })).toThrow(/device identity/i);
  });
  it('rejects invalid stock quantities and impossible reminder lead times', () => {
    expect(() => assertValidAnchorItem({ ...validItem(), quantity: -1 })).toThrow(/quantity/i);
    expect(() => assertValidAnchorItem({ ...validItem(), reminderMinutesBefore: 60 * 24 * 31 })).toThrow(/reminder/i);
  });
  it('rejects duplicate attachment IDs and unsafe path names', () => {
    const attachment = { id: '55f4e9a2-2ce5-4c42-a194-49f4ed5a22a7', name: 'receipt.pdf', mimeType: 'application/pdf', size: 10, chunkCount: 1, createdAt: '2026-10-25T00:00:00.000Z' };
    expect(() => assertValidAnchorItem({ ...validItem(), attachments: [attachment, attachment] })).toThrow(/duplicate attachment/i);
    expect(() => assertValidAnchorItem({ ...validItem(), attachments: [{ ...attachment, name: '../receipt.pdf' }] })).toThrow(/filename/i);
  });
});
