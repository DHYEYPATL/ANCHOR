import type { AnchorItem, ItemKind, ItemStatus } from '../domain/models';
import { calculateDepletion } from '../domain/inventoryMath';

export interface AmbiguityResolution {
  isAmbiguousDate?: boolean;
  dateOptions?: { label: string; iso: string }[];
  isAmbiguousTime?: boolean;
  timeOptions?: { label: string; hour: number; minute: number }[];
  isDosageConflict?: boolean;
  dosageOptions?: { label: string; dailyRate: number; quantity?: number }[];
  isInvalidDate?: boolean;
  invalidReason?: string;
}

export interface ExtractionDraft {
  title: string;
  body: string;
  kind: ItemKind;
  dueAt?: string;
  category?: string;
  sourceText: string;
  confidence: 'high' | 'medium' | 'low';
  status?: ItemStatus;
  warning?: string;
  isCancelled?: boolean;
  quantity?: number;
  dailyRate?: number;
  reorderThreshold?: number;
  safetyBlocked?: boolean;
  unresolvedReason?: string;
  ambiguity?: AmbiguityResolution;
}

const MONTH_NAMES: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

export interface ParsedTime {
  hour?: number;
  minute?: number;
  isAmbiguous?: boolean;
  timeOptions?: { label: string; hour: number; minute: number }[];
}

export function parseTime(text: string): ParsedTime | undefined {
  // Check for midnight (ambiguous between 11:59 PM end-of-day vs 12:00 AM start-of-day)
  if (/\b(?:at\s+)?midnight\b/i.test(text)) {
    return {
      hour: 0,
      minute: 0,
      isAmbiguous: true,
      timeOptions: [
        { label: '11:59 PM (End of day)', hour: 23, minute: 59 },
        { label: '12:00 AM (Start of day)', hour: 0, minute: 0 },
      ],
    };
  }

  // Noon
  if (/\b(?:at\s+)?noon\b/i.test(text)) {
    return { hour: 12, minute: 0, isAmbiguous: false };
  }

  // Check for bare hour like "at 9" without AM or PM -> AMBIGUOUS
  const bareAtMatch = text.match(/\bat\s+(\d{1,2})(?!\s*(?:am|pm|:\d{2}))\b/i);
  if (bareAtMatch) {
    const rawH = parseInt(bareAtMatch[1], 10);
    if (rawH >= 1 && rawH <= 12) {
      const amH = rawH === 12 ? 0 : rawH;
      const pmH = rawH === 12 ? 12 : rawH + 12;
      return {
        isAmbiguous: true,
        timeOptions: [
          { label: `${rawH}:00 AM`, hour: amH, minute: 0 },
          { label: `${rawH}:00 PM`, hour: pmH, minute: 0 },
        ],
      };
    }
  }

  // Explicit "at 10:30 am", "at 11:55 PM", "at 9 am"
  const atMatch = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (atMatch) {
    let hour = parseInt(atMatch[1], 10);
    const minute = atMatch[2] ? parseInt(atMatch[2], 10) : 0;
    const meridiem = atMatch[3].toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute, isAmbiguous: false };
    }
  }

  // Explicit colon "11:55 PM", "14:30"
  const colonMatch = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (colonMatch) {
    let hour = parseInt(colonMatch[1], 10);
    const minute = parseInt(colonMatch[2], 10);
    const meridiem = colonMatch[3]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute, isAmbiguous: false };
    }
  }

  // Explicit "10 am", "5 pm"
  const ampmMatch = text.match(/\b(\d{1,2})\s*(am|pm)\b/i);
  if (ampmMatch) {
    let hour = parseInt(ampmMatch[1], 10);
    const meridiem = ampmMatch[2].toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23) {
      return { hour, minute: 0, isAmbiguous: false };
    }
  }

  return undefined;
}

export interface ParsedDate {
  date?: Date;
  isAmbiguous?: boolean;
  dateOptions?: { label: string; iso: string }[];
  isInvalidDate?: boolean;
  invalidReason?: string;
}

export function parseDate(text: string, now = new Date()): ParsedDate | undefined {
  const lower = text.toLowerCase();

  // Check for explicit deadline change / override in the text first
  const overrideMatch = lower.match(/\b(?:actually[, ]+)?(?:move|moved|change|changed|postpone|postponed|reschedule|rescheduled|extend|extended|shift|shifted)\s+(?:it\s+|the\s+deadline\s+)?to\s+([^\n.!?]+)/i);
  if (overrideMatch) {
    const overridden = parseDate(overrideMatch[1], now);
    if (overridden) return overridden;
  }

  // 1. Slash dates like "04/05"
  const slashMatch = lower.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (slashMatch) {
    const n1 = parseInt(slashMatch[1], 10);
    const n2 = parseInt(slashMatch[2], 10);
    let year = slashMatch[3] ? parseInt(slashMatch[3], 10) : now.getFullYear();
    if (year < 100) year += 2000;

    // If both numbers could be months (1..12) and are different -> AMBIGUOUS
    if (n1 <= 12 && n2 <= 12 && n1 !== n2) {
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const optA = new Date(year, n2 - 1, n1); // DD/MM (e.g. 4 May)
      const optB = new Date(year, n1 - 1, n2); // MM/DD (e.g. 5 April)
      return {
        isAmbiguous: true,
        dateOptions: [
          { label: `${n1} ${monthNames[n2 - 1]} (${slashMatch[0]} DD/MM)`, iso: optA.toISOString() },
          { label: `${monthNames[n1 - 1]} ${n2} (${slashMatch[0]} MM/DD)`, iso: optB.toISOString() },
        ],
      };
    }

    let month = (n1 > 12 ? n2 : n1) - 1;
    let day = n1 > 12 ? n1 : n2;
    const maxDays = new Date(year, month + 1, 0).getDate();
    if (day > maxDays || day < 1) {
      return {
        isAmbiguous: true,
        isInvalidDate: true,
        invalidReason: `Month ${month + 1} does not have ${day} days.`,
      };
    }
    return { date: new Date(year, month, day), isAmbiguous: false };
  }

  // 2. Today / Tomorrow
  if (/\btoday\b/.test(lower)) {
    return { date: new Date(now.getFullYear(), now.getMonth(), now.getDate()), isAmbiguous: false };
  }
  if (/\btomorrow\b/.test(lower)) {
    return { date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), isAmbiguous: false };
  }

  // 3. Month names
  const monthMatchA = lower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/);
  if (monthMatchA) {
    const month = MONTH_NAMES[monthMatchA[1]];
    const day = parseInt(monthMatchA[2], 10);
    const year = monthMatchA[3] ? parseInt(monthMatchA[3], 10) : (now.getMonth() > month || (now.getMonth() === month && now.getDate() > day) ? now.getFullYear() + 1 : now.getFullYear());
    const maxDays = new Date(year, month + 1, 0).getDate();
    if (day > maxDays || day < 1) {
      const mName = monthMatchA[1].charAt(0).toUpperCase() + monthMatchA[1].slice(1);
      return {
        isAmbiguous: true,
        isInvalidDate: true,
        invalidReason: `${mName} only has ${maxDays} days in ${year} (cannot schedule for ${mName} ${day}).`,
      };
    }
    return { date: new Date(year, month, day), isAmbiguous: false };
  }
  const monthMatchB = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s*,?\s*(\d{4}))?\b/);
  if (monthMatchB) {
    const month = MONTH_NAMES[monthMatchB[2]];
    const day = parseInt(monthMatchB[1], 10);
    const year = monthMatchB[3] ? parseInt(monthMatchB[3], 10) : (now.getMonth() > month || (now.getMonth() === month && now.getDate() > day) ? now.getFullYear() + 1 : now.getFullYear());
    const maxDays = new Date(year, month + 1, 0).getDate();
    if (day > maxDays || day < 1) {
      const mName = monthMatchB[2].charAt(0).toUpperCase() + monthMatchB[2].slice(1);
      return {
        isAmbiguous: true,
        isInvalidDate: true,
        invalidReason: `${mName} only has ${maxDays} days in ${year} (cannot schedule for ${mName} ${day}).`,
      };
    }
    return { date: new Date(year, month, day), isAmbiguous: false };
  }

  // 4. In X days
  const inDays = lower.match(/\bin\s+(\d{1,3})\s+days?\b/);
  if (inDays) {
    return { date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + Math.min(Number(inDays[1]), 365)), isAmbiguous: false };
  }

  // 5. ISO YYYY-MM-DD
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (date.getFullYear() === Number(iso[1]) && date.getMonth() === Number(iso[2]) - 1 && date.getDate() === Number(iso[3])) {
      return { date, isAmbiguous: false };
    }
  }

  // 6. Weekdays
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayMatch = lower.match(/\b(?:by|on|this|next)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (dayMatch) {
    const isNext = /\bnext\s+/i.test(dayMatch[0]);
    const target = weekdays.indexOf(dayMatch[1]);
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let delta = (target - date.getDay() + 7) % 7;
    if (delta === 0 || isNext) delta += 7;
    date.setDate(date.getDate() + delta);
    return { date, isAmbiguous: false };
  }

  return undefined;
}

export function dateFromText(text: string, now = new Date()): string | undefined {
  const lower = text.toLowerCase();

  // Standalone relative offset: "in 45 minutes", "in 2 hours", "in 30 mins" without a base calendar date
  const standaloneOffsetMatch = lower.match(/\b(?:remind me\s+)?in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/);
  if (standaloneOffsetMatch && !/\bat\s+\d/i.test(text) && !/\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(lower)) {
    const amount = parseInt(standaloneOffsetMatch[1], 10);
    const isHours = standaloneOffsetMatch[2].startsWith('h');
    const addedMs = amount * (isHours ? 3600_000 : 60_000);
    return new Date(now.getTime() + addedMs).toISOString();
  }

  const parsedD = parseDate(text, now);
  if (!parsedD || parsedD.isAmbiguous || !parsedD.date) return undefined;

  const parsedT = parseTime(text);
  if (parsedT?.isAmbiguous) return undefined; // Time is unresolved!

  const date = new Date(parsedD.date.getTime());
  if (parsedT?.hour !== undefined) {
    date.setHours(parsedT.hour, parsedT.minute ?? 0, 0, 0);
  } else {
    date.setHours(9, 0, 0, 0);
  }

  // Relative offset addition: "in 10 minutes", "in 2 hours"
  const offsetMatch = lower.match(/\b(?:remind me\s+)?in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b/);
  if (offsetMatch && parsedT?.hour !== undefined) {
    const amount = parseInt(offsetMatch[1], 10);
    const isHours = offsetMatch[2].startsWith('h');
    const addedMs = amount * (isHours ? 3600_000 : 60_000);
    return new Date(date.getTime() + addedMs).toISOString();
  }

  return date.toISOString();
}

function inferKind(text: string): ItemKind {
  const s = text.toLowerCase();
  if (/\b(i promised|i said i would|promised to|owe .+ a reply|follow up with)\b/.test(s)) return 'promise';
  if (/\b(appointment|meeting|interview|class|exam|flight|event)\b/.test(s)) return 'event';
  if (/\b(stock|left in|running low|reorder|restock|buy more|buy\b|grocery|groceries|running out|tablets remaining|dose|prescription)\b/.test(s)) return 'consumable';
  if (/\b(warranty|invoice|receipt|subscription|policy|document)\b/.test(s)) return 'document';
  if (/\b(note|remember that|idea:|thought:|decision:)\b/.test(s)) return 'note';
  return 'task';
}

function stripCommand(text: string) {
  const s = text.trim()
    .replace(/^(hey\s+anchor[,;:]?\s*)/i, '')
    .replace(/^(please\s+)?(remind me to|remind me about|remind me|remember to|remember that|add a task to|add to my list|todo:?|task:?)[\s:]*/i, '')
    .replace(/^(?:i\s+)?(?:no longer need to|don't need to)\s+/i, '')
    .replace(/^(?:please\s+)?(?:cancel|delete|remove)\s+(?:the\s+|my\s+)?/i, '')
    .replace(/\b(today|tomorrow|in\s+\d+\s+days?|in\s+\d+\s*(?:minutes?|mins?|hours?|hrs?)|20\d{2}-\d{2}-\d{2})\b/ig, '')
    .replace(/\b(?:by|on|this|next)\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/ig, '')
    .replace(/\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/ig, '')
    .replace(/\b(?:on\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*,?\s*\d{4})?\b/ig, '')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:\s*,?\s*\d{4})?\b/ig, '')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, '')
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/ig, '')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/ig, '')
    .replace(/\b(?:at\s+)?(?:midnight|noon)\b/ig, '')
    .replace(/\b(?:actually[, ]+)?(?:move|moved|change|changed|postpone|postponed|reschedule|rescheduled|extend|extended|shift|shifted)\s+(?:it\s+|the\s+deadline\s+)?to\s+[^\n.!?]+/ig, '')
    .replace(/\b(?:actually[, ]+)?(?:don't remind me|no need to remind|already (?:paid|done|finished|completed|submitted)|never\s*mind|cancel that|scratch that|disregard|forget it)[^.]*\b/ig, '')
    .replace(/[.!?,;:\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function extractDraft(sourceText: string, now = new Date()): ExtractionDraft {
  const text = sourceText.trim();
  if (!text) throw new Error('Write or paste something first.');
  if (text.length > 20_000) throw new Error('This capture is too long for the quick extractor (20,000 characters max). Split it into smaller captures.');

  // Check 1: Self-cancellation / Negation / Deletion request
  const isCancelled = /\b(?:actually[, ]+)?(?:don't remind me|no need to remind|no longer need to|don't need to|already (?:paid|done|finished|completed|submitted)|never\s*mind|cancel that|scratch that|disregard|forget it|cancel\s+(?:the\s+|my\s+)?|delete\s+(?:the\s+|my\s+)?|remove\s+(?:the\s+|my\s+)?)\b/i.test(text);

  // Check 2: Conflicting medical / clinical dosages
  // e.g. "prescription says 1 tablet daily. handwritten note says 2 tablets daily."
  const doseMatches = [...text.matchAll(/\b(?:take|taking|says?|states?|prescribed)?\s*(\d+(?:\.\d+)?)\s*(?:tablets?|pills?|capsules?|mg|ml)\s*(daily|per day|twice daily|a day|each day)\b/gi)];
  let clinicalConflictWarning: string | undefined;
  let isDosageConflict = false;
  let dosageOptions: { label: string; dailyRate: number }[] | undefined;

  if (doseMatches.length >= 2) {
    const d1 = doseMatches[0][1];
    const d2 = doseMatches[1][1];
    if (d1 !== d2) {
      isDosageConflict = true;
      clinicalConflictWarning = `⚠️ Clinical conflict: Conflicting dosage instructions detected (${d1} tablet daily vs ${d2} tablets daily). Regimen is unverified.`;
      dosageOptions = [
        { label: `${d1} tablet daily (Prescription)`, dailyRate: Number(d1) },
        { label: `${d2} tablets daily (Handwritten note)`, dailyRate: Number(d2) },
      ];
    }
  }

  // Check 3: Medication & Inventory Depletion Calculation
  const qtyMatch = text.match(/\b(\d+)\s*(?:tablets?|pills?|doses?|capsules?|units?|items?)\s*(?:remaining|left|in stock|on hand)\b/i) ||
                   text.match(/\b(?:have|stock(?:ed)?|on hand)\s+(\d+)\s*(?:tablets?|pills?|doses?|capsules?|units?|items?)\b/i);
  const usageMatch = text.match(/\b(?:regimen|usage|consumption|take)\s+(?:is\s+)?(\d+(?:\.\d+)?)\s*(?:tablets?|pills?|doses?|capsules?|units?|items?)?\s*(?:per day|daily|a day|each day)\b/i) ||
                     text.match(/\b(\d+(?:\.\d+)?)\s*(?:tablets?|pills?|doses?|capsules?|units?|items?)\s*(?:per day|daily|a day|each day)\b/i);
  const noticeMatch = text.match(/\b(\d+)\s*days?(?:['’]|\s+days?)?\s*notice\s+to\s+reorder\b/i) ||
                      text.match(/\breorder\s+(?:notice\s+)?(\d+)\s*days?\b/i);

  if (qtyMatch && usageMatch && !isCancelled && !isDosageConflict) {
    const q = parseFloat(qtyMatch[1]);
    const u = parseFloat(usageMatch[1]);
    const lead = noticeMatch ? parseInt(noticeMatch[1], 10) : 3;
    const depletion = calculateDepletion(q, u, lead, now);
    if (depletion) {
      return {
        title: `Reorder medication (${depletion.daysRemaining} days supply remaining)`,
        body: `${text}\n\n[Depletion: ${depletion.summary}]`,
        kind: 'consumable',
        category: 'Medication',
        dueAt: depletion.reorderDate,
        quantity: q,
        dailyRate: u,
        reorderThreshold: u * lead,
        sourceText: text,
        confidence: 'high',
      };
    }
  }

  // Check 4: Ambiguous or invalid date and time
  const parsedDate = parseDate(text, now);
  const parsedTime = parseTime(text);
  const isAmbiguousDate = Boolean(parsedDate?.isAmbiguous);
  const isAmbiguousTime = Boolean(parsedTime?.isAmbiguous);
  const isInvalidDate = Boolean(parsedDate?.isInvalidDate);

  let ambiguityWarning: string | undefined;
  if (isInvalidDate) {
    ambiguityWarning = `⚠️ Impossible calendar date: ${parsedDate?.invalidReason} Please select a valid date before scheduling.`;
  } else if (isAmbiguousDate || isAmbiguousTime) {
    const parts = [];
    if (isAmbiguousDate) parts.push('date format is ambiguous (could be DD/MM or MM/DD)');
    if (isAmbiguousTime) parts.push('time has no AM/PM indicator or is midnight');
    ambiguityWarning = `⚠️ Unresolved ambiguity: ${parts.join(' and ')}. Please select the intended value before scheduling.`;
  }

  const safetyBlocked = isDosageConflict || isAmbiguousDate || isAmbiguousTime || isInvalidDate;
  const unresolvedReason = clinicalConflictWarning ?? ambiguityWarning;

  const ambiguity: AmbiguityResolution | undefined = (safetyBlocked || isDosageConflict || isAmbiguousDate || isAmbiguousTime || isInvalidDate) ? {
    isAmbiguousDate,
    dateOptions: parsedDate?.dateOptions,
    isAmbiguousTime,
    timeOptions: parsedTime?.timeOptions,
    isDosageConflict,
    dosageOptions,
    isInvalidDate,
    invalidReason: parsedDate?.invalidReason,
  } : undefined;

  const kind = isDosageConflict ? 'consumable' : inferKind(text);
  // Do NOT schedule dueAt if cancelled or if safetyBlocked!
  const dueAt = (isCancelled || safetyBlocked) ? undefined : dateFromText(text, now);

  const isSensitive = /\b(?:password|passcode|pin\b|locker\s+code|door\s+code|gate\s+code|secret\b|credential|api[_-]?key|access\s+code|vault\s+code)\b/i.test(text);

  const cleaned = stripCommand(text);
  const firstSentence = cleaned.split(/[\n.!?]/).map((part) => part.trim()).find(Boolean) ?? cleaned;
  let title = firstSentence.length > 100 ? `${firstSentence.slice(0, 97).trimEnd()}…` : firstSentence;
  if (isCancelled) {
    title = title ? `${title} (already completed / no longer needed)` : 'Cancelled reminder (already completed)';
  } else if (isSensitive) {
    // Mask sensitive codes in title: e.g. "My locker code is 1234" -> "My locker code is ••••"
    title = title.replace(/\b(?:is\s+|:\s*)(\d{3,8}|[a-zA-Z0-9!@#$%^&*]{4,})\b/i, 'is ••••');
  }

  const warning = [clinicalConflictWarning, ambiguityWarning].filter(Boolean).join(' ') || undefined;

  return {
    title: title || 'Untitled memory',
    body: text,
    kind: isCancelled ? 'note' : kind,
    dueAt,
    category: isSensitive
      ? 'Confidential'
      : kind === 'consumable'
        ? (/\b(tablets?|pills?|medicine|medication|dose|regimen|capsules?|rx)\b/i.test(text) ? 'Medication' : 'Household')
        : kind === 'promise' ? 'Follow-up' : undefined,
    sourceText: text,
    confidence: safetyBlocked ? 'low' : isCancelled ? 'high' : (dueAt || kind !== 'task') ? 'medium' : 'low',
    status: isCancelled ? 'done' : 'open',
    isCancelled,
    warning,
    safetyBlocked,
    unresolvedReason,
    ambiguity,
  };
}

export function extractMultipleDrafts(sourceText: string, now = new Date()): ExtractionDraft[] {
  const text = sourceText.trim();
  if (!text) throw new Error('Write or paste something first.');

  // Check 1: If input contains a cancellation / self-correction in a later sentence,
  // do NOT split into separate items! Treat as one single cancelled/completed discourse unit.
  // e.g. "Remind me to pay rent tomorrow. Actually, I already paid it."
  const rawSentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.endsWith(':'));

  if (rawSentences.length >= 2) {
    const hasCorrection = rawSentences.some((s, idx) => idx > 0 && /\b(?:actually|wait|never\s*mind|scratch that|cancel that|forget it|already paid|already done|already submitted|already sent|move (?:it )?to|change (?:it )?to|reschedule (?:it )?to)\b/i.test(s));
    if (hasCorrection) {
      return [extractDraft(sourceText, now)];
    }
  }

  // Check 2: Check for per-task deadline updates in discourse:
  // e.g. "Submit the report on Monday and pay the fee on Tuesday. The report deadline has changed to Wednesday."
  const deadlineOverrides: { target: string; rawDeadline: string }[] = [];
  const taskSentences: string[] = [];

  for (const sentence of (rawSentences.length >= 2 ? rawSentences : [text])) {
    const overrideMatch = sentence.match(/\bthe\s+([a-z0-9_-]+)\s+deadline\s+(?:has\s+)?(?:been\s+)?(?:changed|moved|postponed|rescheduled|extended)\s+to\s+([^\n.!?]+)/i);
    if (overrideMatch) {
      deadlineOverrides.push({
        target: overrideMatch[1].toLowerCase(),
        rawDeadline: overrideMatch[2].trim(),
      });
    } else {
      taskSentences.push(sentence);
    }
  }

  const rawLines = text
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let candidates: string[] = [];
  if (rawLines.length >= 2) {
    const hasBullets = rawLines.some((l) => /^[-*•\d+.]\s+/.test(l));
    if (hasBullets) {
      candidates = rawLines.filter((l) => /^[-*•\d+.]\s+/.test(l) || dateFromText(l, now) !== undefined);
    } else {
      candidates = rawLines.filter((l) => !l.endsWith(':'));
    }
  } else if (taskSentences.length >= 2) {
    candidates = taskSentences;
  } else {
    // Try splitting on coordinating conjunctions and clauses
    // e.g. "Submit the report on Monday and pay the fee on Tuesday"
    const clauses = (taskSentences[0] || text)
      .split(/(?:,\s*(?:and\s+)?|;\s*|\s+and\s+(?=(?:pay|call|buy|remember|promised|meet|remind|restock|submit)\b))/i)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (clauses.length >= 2) {
      candidates = clauses;
    }
  }

  if (candidates.length >= 2) {
    const isActionable = (item: string) => {
      const clean = item.replace(/^[-*•\d+.]\s+/, '').trim();
      return (
        /^[-*•\d+.]\s+/.test(item) ||
        dateFromText(clean, now) !== undefined ||
        /\b(remind|remember|promised|said i would|owe|running low|restock|reorder|buy|pay|call|stock|appointment|meeting|task|todo|submit)\b/i.test(clean) ||
        inferKind(clean) !== 'note'
      );
    };

    const qualifying = candidates.filter(isActionable);
    if (qualifying.length >= 2) {
      const drafts: ExtractionDraft[] = [];
      for (const item of qualifying) {
        const clean = item.replace(/^[-*•\d+.]\s+/, '').trim();
        if (!clean) continue;
        try {
          // Check if this item matches any per-task deadline override
          let targetText = clean;
          let overriddenDueAt: string | undefined;

          for (const override of deadlineOverrides) {
            if (clean.toLowerCase().includes(override.target)) {
              overriddenDueAt = dateFromText(override.rawDeadline, now);
              targetText = `${clean} [deadline changed to ${override.rawDeadline}]`;
              break;
            }
          }

          const draft = extractDraft(clean, now);
          drafts.push({
            ...draft,
            dueAt: overriddenDueAt ?? draft.dueAt,
            sourceText: text,
            body: targetText,
          });
        } catch {
          // Skip invalid
        }
      }
      if (drafts.length >= 2) {
        return drafts;
      }
    }
  }

  return [extractDraft(sourceText, now)];
}

export function toItemDraft(draft: ExtractionDraft): Partial<AnchorItem> & Pick<AnchorItem, 'title' | 'kind'> {
  return {
    title: draft.title,
    body: draft.body,
    kind: draft.kind,
    dueAt: draft.dueAt,
    category: draft.category,
    sourceText: draft.sourceText,
    sourceLabel: 'Quick capture',
    confidence: draft.confidence,
    status: draft.status ?? (draft.isCancelled ? 'done' : 'open'),
    quantity: draft.quantity,
    dailyRate: draft.dailyRate,
    reorderThreshold: draft.reorderThreshold,
    safetyBlocked: draft.safetyBlocked,
    unresolvedReason: draft.unresolvedReason,
  };
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


