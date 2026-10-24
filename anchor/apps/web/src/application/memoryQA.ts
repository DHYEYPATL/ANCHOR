/**
 * Structured Memory Q&A & Intent Router.
 * Answers natural language questions like:
 * - "What is due today / this week?"
 * - "What am I running low on?"
 * - "What did I promise?"
 * - "What should I do next?"
 * Strictly grounded in local records, zero hallucinations, zero cloud API tokens.
 */

import type { AnchorItem } from '../domain/models';
import { isDueToday, isOverdue } from './extractor';

export interface MemoryAnswer {
  intent: 'due' | 'inventory_low' | 'promises' | 'next_action' | 'summary' | 'unknown';
  headline: string;
  explanation: string;
  matchedItems: AnchorItem[];
}

export function answerMemoryQuery(query: string, items: AnchorItem[]): MemoryAnswer {
  const q = query.toLowerCase().trim();
  const activeItems = items.filter((i) => !i.deletedAt && i.status !== 'done');

  // 1. "What am I low on / running out of?"
  if (/\b(low on|running low|running out|restock|reorder|out of stock|supplies|inventory)\b/.test(q)) {
    const consumables = activeItems.filter((i) => i.kind === 'consumable');
    const lowConsumables = consumables.filter((i) => (i.quantity ?? 0) <= 2);
    const target = lowConsumables.length > 0 ? lowConsumables : consumables;

    return {
      intent: 'inventory_low',
      headline: target.length > 0
        ? `Found ${target.length} item${target.length === 1 ? '' : 's'} on your inventory radar:`
        : 'All inventory items are currently stocked.',
      explanation: target.length > 0
        ? target.map((i) => `• ${i.title}: ${i.quantity !== undefined ? `${i.quantity} ${i.unit || 'units'}` : 'Needs quantity check'}`).join('\n')
        : 'No consumables are marked low or out of stock.',
      matchedItems: target,
    };
  }

  // 2. "What did I promise / owe / follow up?"
  if (/\b(promise|promised|owe|owing|follow up|open loop|loops)\b/.test(q)) {
    const promises = activeItems.filter((i) => i.kind === 'promise');
    return {
      intent: 'promises',
      headline: promises.length > 0
        ? `You have ${promises.length} open loop${promises.length === 1 ? '' : 's'}:`
        : 'No open promises or follow-ups right now.',
      explanation: promises.length > 0
        ? promises.map((i) => `• ${i.title}${i.dueAt ? ` (due ${new Date(i.dueAt).toLocaleDateString()})` : ''}`).join('\n')
        : 'All promises and commitments are fulfilled.',
      matchedItems: promises,
    };
  }

  // 3. "What should I do next / priority / next action?"
  if (/\b(what should i do|what to do|next action|priority|prioritize|recommend|focus)\b/.test(q)) {
    const overdue = activeItems.filter((i) => isOverdue(i.dueAt));
    const dueToday = activeItems.filter((i) => isDueToday(i.dueAt));
    const promises = activeItems.filter((i) => i.kind === 'promise' && !isDueToday(i.dueAt) && !isOverdue(i.dueAt));
    const otherTasks = activeItems.filter((i) => i.kind === 'task' && !isDueToday(i.dueAt) && !isOverdue(i.dueAt));

    const prioritized = [...overdue, ...dueToday, ...promises, ...otherTasks];
    const topItem = prioritized[0];

    return {
      intent: 'next_action',
      headline: topItem ? `Recommended next focus: “${topItem.title}”` : 'Nothing urgent on your plate.',
      explanation: topItem
        ? `${overdue.length > 0 ? `Urgent: You have ${overdue.length} overdue item(s). ` : ''}${dueToday.length > 0 ? `${dueToday.length} item(s) due today. ` : ''}Start with “${topItem.title}”.`
        : 'You have zero open or overdue tasks right now. Great job!',
      matchedItems: prioritized.slice(0, 5),
    };
  }

  // 4. "What is due / agenda / today / upcoming?"
  if (/\b(due|agenda|schedule|upcoming|today|tomorrow|calendar)\b/.test(q)) {
    const overdue = activeItems.filter((i) => isOverdue(i.dueAt));
    const today = activeItems.filter((i) => isDueToday(i.dueAt));
    const dueSoon = activeItems.filter((i) => {
      if (!i.dueAt) return false;
      const t = new Date(i.dueAt).getTime();
      return t > Date.now() && t < Date.now() + 7 * 86_400_000 && !isDueToday(i.dueAt);
    });

    const relevant = [...overdue, ...today, ...dueSoon];

    return {
      intent: 'due',
      headline: relevant.length > 0
        ? `Found ${relevant.length} scheduled item${relevant.length === 1 ? '' : 's'}:`
        : 'No upcoming deadlines or scheduled events in the next 7 days.',
      explanation: relevant.length > 0
        ? relevant.map((i) => `• ${isOverdue(i.dueAt) ? '[OVERDUE] ' : isDueToday(i.dueAt) ? '[TODAY] ' : ''}${i.title} (${i.dueAt ? new Date(i.dueAt).toLocaleDateString() : 'No date'})`).join('\n')
        : 'Calendar is clear for the coming week.',
      matchedItems: relevant,
    };
  }

  // Fallback to substring matching across title and body
  const matched = items.filter((i) => !i.deletedAt && (
    i.title.toLowerCase().includes(q) ||
    i.body.toLowerCase().includes(q) ||
    (i.category && i.category.toLowerCase().includes(q))
  ));

  return {
    intent: 'unknown',
    headline: matched.length > 0 ? `Found ${matched.length} record${matched.length === 1 ? '' : 's'} matching “${query}”:` : `No records found matching “${query}”.`,
    explanation: matched.length > 0 ? matched.map((i) => `• ${i.title}`).join('\n') : 'Try asking "What is due?", "What am I low on?", or "What should I do next?".',
    matchedItems: matched,
  };
}
