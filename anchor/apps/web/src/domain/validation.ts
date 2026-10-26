import type { AnchorItem, ItemKind, ItemStatus, VersionVector } from './models';

export const MAX_RECORD_TITLE = 200;
export const MAX_RECORD_BODY = 20_000;
export const MAX_RECORD_SOURCE = 20_000;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 256 * 1024;
const MAX_ATTACHMENTS_PER_RECORD = 100;
const KINDS = new Set<ItemKind>(['task', 'event', 'promise', 'note', 'consumable', 'document']);
const STATUSES = new Set<ItemStatus>(['open', 'done', 'archived']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_ID = /^device-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_KEYS = new Set(['id','kind','title','body','status','createdAt','updatedAt','dueAt','category','sourceText','sourceLabel','confidence','quantity','unit','dailyRate','reorderThreshold','recurrence','doseLogs','versionVector','deletedAt','reminderMinutesBefore','attachments','safetyBlocked','unresolvedReason']);
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isBoundedString(value: unknown, max: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);
}
function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= monthDays && hour <= 23 && minute <= 59 && second <= 59;
}
function fail(message: string): never { throw new Error(`Record validation failed: ${message}`); }

export function assertValidVersionVector(value: unknown): asserts value is VersionVector {
  if (!isObject(value)) fail('version vector must be an object.');
  const entries = Object.entries(value);
  if (entries.length > 64) fail('too many device versions.');
  for (const [device, counter] of entries) {
    if (RESERVED_KEYS.has(device) || !DEVICE_ID.test(device)) fail('invalid device identity in version vector.');
    if (!Number.isSafeInteger(counter) || Number(counter) < 0) fail('invalid version counter.');
  }
}

export function assertValidAnchorItem(value: unknown): asserts value is AnchorItem {
  if (!isObject(value)) fail('item must be an object.');
  for (const key of Object.keys(value)) if (!ITEM_KEYS.has(key)) fail(`unsupported field ${key}.`);
  if (typeof value.id !== 'string' || !UUID.test(value.id)) fail('invalid item ID.');
  if (typeof value.kind !== 'string' || !KINDS.has(value.kind as ItemKind)) fail('unsupported item kind.');
  if (!isBoundedString(value.title, MAX_RECORD_TITLE, false)) fail('title is missing or too long.');
  if (!isBoundedString(value.body, MAX_RECORD_BODY)) fail('details are too long.');
  if (typeof value.status !== 'string' || !STATUSES.has(value.status as ItemStatus)) fail('invalid item status.');
  if (!isDate(value.createdAt) || !isDate(value.updatedAt)) fail('invalid creation or update date.');
  if (value.dueAt !== undefined && value.dueAt !== null && !isDate(value.dueAt)) fail('invalid due date.');
  if (value.deletedAt !== undefined && value.deletedAt !== null && !isDate(value.deletedAt)) fail('invalid deletion date.');
  for (const field of ['category', 'sourceLabel', 'unit'] as const) {
    if (value[field] !== undefined && value[field] !== null && !isBoundedString(value[field], field === 'category' ? 80 : field === 'unit' ? 30 : 120)) fail(`${field} is too long.`);
  }
  if (value.sourceText !== undefined && value.sourceText !== null && !isBoundedString(value.sourceText, MAX_RECORD_SOURCE)) fail('source text is too long.');
  if (value.confidence !== undefined && value.confidence !== 'high' && value.confidence !== 'medium' && value.confidence !== 'low') fail('invalid confidence label.');
  if (value.quantity !== undefined && value.quantity !== null && (typeof value.quantity !== 'number' || !Number.isFinite(value.quantity) || value.quantity < 0 || value.quantity > 1e12)) fail('quantity is outside the supported range.');
  if (value.reminderMinutesBefore !== undefined && value.reminderMinutesBefore !== null && (!Number.isSafeInteger(value.reminderMinutesBefore) || Number(value.reminderMinutesBefore) < 0 || Number(value.reminderMinutesBefore) > 30 * 24 * 60)) fail('invalid reminder lead time.');
  if (value.dailyRate !== undefined && value.dailyRate !== null && (typeof value.dailyRate !== 'number' || !Number.isFinite(value.dailyRate) || value.dailyRate <= 0)) fail('invalid daily rate.');
  if (value.reorderThreshold !== undefined && value.reorderThreshold !== null && (!Number.isSafeInteger(value.reorderThreshold) || Number(value.reorderThreshold) < 0)) fail('invalid reorder threshold.');
  if (value.recurrence !== undefined && value.recurrence !== null && !['daily', 'weekly', 'monthly', 'yearly'].includes(String(value.recurrence))) fail('invalid recurrence.');
  if (value.doseLogs !== undefined && value.doseLogs !== null && !Array.isArray(value.doseLogs)) fail('invalid dose logs.');
  if (value.safetyBlocked !== undefined && value.safetyBlocked !== null && typeof value.safetyBlocked !== 'boolean') fail('invalid safetyBlocked flag.');
  if (value.unresolvedReason !== undefined && value.unresolvedReason !== null && !isBoundedString(value.unresolvedReason, 500)) fail('invalid unresolvedReason.');
  if (value.safetyBlocked) {
    if (value.dueAt) fail('cannot schedule a due date on an item that is safety blocked / unresolved.');
    if (value.kind === 'consumable' && (value.dailyRate || value.quantity)) fail('cannot activate dosage or inventory schedule on a safety blocked item.');
  }
  assertValidVersionVector(value.versionVector);
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > MAX_ATTACHMENTS_PER_RECORD) fail('invalid attachment list.');
    const ids = new Set<string>();
    for (const attachment of value.attachments) {
      if (!isObject(attachment) || typeof attachment.id !== 'string' || !UUID.test(attachment.id)) fail('invalid attachment identity.');
      if (ids.has(attachment.id)) fail('duplicate attachment identity.');
      ids.add(attachment.id);
      if (!isBoundedString(attachment.name, 180, false) || /[\\/\u0000-\u001f\u007f]/.test(attachment.name)) fail('invalid attachment filename.');
      if (!isBoundedString(attachment.mimeType, 120, false) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(attachment.mimeType)) fail('invalid attachment MIME type.');
      if (!Number.isSafeInteger(attachment.size) || Number(attachment.size) < 1 || Number(attachment.size) > MAX_ATTACHMENT_BYTES) fail('attachment size exceeds the supported limit.');
      const expectedChunks = Math.ceil(Number(attachment.size) / ATTACHMENT_CHUNK_BYTES);
      if (!Number.isSafeInteger(attachment.chunkCount) || attachment.chunkCount !== expectedChunks) fail('attachment chunk count does not match its size.');
      if (!isDate(attachment.createdAt)) fail('invalid attachment date.');
    }
  }
}

export function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
export function isDeviceId(value: unknown): value is string { return typeof value === 'string' && DEVICE_ID.test(value); }
export function isOperationId(value: unknown): value is string { return typeof value === 'string' && /^op-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
