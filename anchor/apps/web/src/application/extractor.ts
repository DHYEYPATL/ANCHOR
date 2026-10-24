import type { AnchorItem, ItemKind } from '../domain/models';

export interface ExtractionDraft {
  title: string;
  body: string;
  kind: ItemKind;
  dueAt?: string;
  category?: string;
  sourceText: string;
  confidence: 'high' | 'medium' | 'low';
}

function atLocalMidnight(date: Date): string { date.setHours(9, 0, 0, 0); return date.toISOString(); }
function dateFromText(text: string): string | undefined {
  const lower = text.toLowerCase();
  const now = new Date();
  if (/\btoday\b/.test(lower)) return atLocalMidnight(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  if (/\btomorrow\b/.test(lower)) return atLocalMidnight(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const inDays = lower.match(/\bin\s+(\d{1,3})\s+days?\b/);
  if (inDays) return atLocalMidnight(new Date(now.getFullYear(), now.getMonth(), now.getDate() + Math.min(Number(inDays[1]), 365)));
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 9);
    if (date.getFullYear() === Number(iso[1]) && date.getMonth() === Number(iso[2]) - 1 && date.getDate() === Number(iso[3])) return date.toISOString();
  }
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const match = lower.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (match) {
    const target = weekdays.indexOf(match[1]);
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let delta = (target - date.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    date.setDate(date.getDate() + delta);
    return atLocalMidnight(date);
  }
  return undefined;
}

function inferKind(text: string): ItemKind {
  const s = text.toLowerCase();
  if (/\b(i promised|i said i would|promised to|owe .+ a reply|follow up with)\b/.test(s)) return 'promise';
  if (/\b(appointment|meeting|interview|class|exam|flight|event)\b/.test(s)) return 'event';
  if (/\b(stock|left in|running low|reorder|restock|buy more|running out)\b/.test(s)) return 'consumable';
  if (/\b(warranty|invoice|receipt|subscription|policy|document)\b/.test(s)) return 'document';
  if (/\b(note|remember that|idea:|thought:|decision:)\b/.test(s)) return 'note';
  return 'task';
}

function stripCommand(text: string) {
  return text.trim()
    .replace(/^(hey\s+anchor[,;:]?\s*)/i, '')
    .replace(/^(please\s+)?(remind me to|remind me|remember to|remember that|add a task to|add to my list|todo:?|task:?)[\s:]*/i, '')
    .replace(/\b(today|tomorrow|next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|in\s+\d+\s+days?|20\d{2}-\d{2}-\d{2})\b/ig, '')
    .replace(/[.!?,;:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractDraft(sourceText: string): ExtractionDraft {
  const text = sourceText.trim();
  if (!text) throw new Error('Write or paste something first.');
  if (text.length > 20_000) throw new Error('This capture is too long for the quick extractor (20,000 characters max). Split it into smaller captures.');
  const kind = inferKind(text);
  const dueAt = dateFromText(text);
  const cleaned = stripCommand(text);
  const firstSentence = cleaned.split(/[\n.!?]/).map((part) => part.trim()).find(Boolean) ?? cleaned;
  const title = firstSentence.length > 100 ? `${firstSentence.slice(0, 97).trimEnd()}…` : firstSentence;
  return {
    title: title || 'Untitled memory',
    body: text,
    kind,
    dueAt,
    category: kind === 'consumable' ? 'Household' : kind === 'promise' ? 'Follow-up' : undefined,
    sourceText: text,
    confidence: (dueAt || kind !== 'task') ? 'medium' : 'low',
  };
}

export function extractMultipleDrafts(sourceText: string): ExtractionDraft[] {
  const text = sourceText.trim();
  if (!text) throw new Error('Write or paste something first.');

  // Check for multi-line circular, timetable, or checklist patterns
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Identify lines that look like list items or individual events/dates
  const itemLines = lines.filter((line) => {
    return /^[-*•\d+.]\s+/.test(line) || dateFromText(line) !== undefined;
  });

  if (itemLines.length >= 2) {
    const drafts: ExtractionDraft[] = [];
    for (const rawLine of itemLines) {
      const cleanLine = rawLine.replace(/^[-*•\d+.]\s+/, '').trim();
      if (!cleanLine) continue;
      try {
        const draft = extractDraft(cleanLine);
        drafts.push({
          ...draft,
          sourceText: text,
        });
      } catch {
        // Skip invalid line
      }
    }
    if (drafts.length >= 2) {
      return drafts;
    }
  }

  return [extractDraft(sourceText)];
}

export function toItemDraft(draft: ExtractionDraft): Partial<AnchorItem> & Pick<AnchorItem, 'title' | 'kind'> {
  return { title: draft.title, body: draft.body, kind: draft.kind, dueAt: draft.dueAt, category: draft.category, sourceText: draft.sourceText, sourceLabel: 'Quick capture', confidence: draft.confidence, status: 'open' };
}

export function formatDue(value?: string): string {
  if (!value) return 'No date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date needs review';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(date);
}

export function isDueToday(value?: string): boolean {
  if (!value) return false;
  const date = new Date(value); const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export function isOverdue(value?: string): boolean { return !!value && new Date(value).getTime() < Date.now() && !isDueToday(value); }
