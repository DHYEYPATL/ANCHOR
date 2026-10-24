import type { AnchorItem } from './models';

export interface CancellationGuide {
  isSubscription: boolean;
  serviceName: string;
  renewalDate?: string;
  checklist: string[];
}

/**
 * Extracts and generates safe cancellation instructions for free trials and recurring subscriptions.
 */
export function getSubscriptionCancellationGuide(item: AnchorItem): CancellationGuide {
  const combined = `${item.title} ${item.body}`.toLowerCase();
  const isSub = item.kind === 'document' ||
    combined.includes('trial') ||
    combined.includes('subscription') ||
    combined.includes('membership') ||
    combined.includes('auto-renew') ||
    combined.includes('billed') ||
    combined.includes('/month') ||
    combined.includes('/year');

  const titleWords = item.title.replace(/(?:subscription|trial|free|annual|monthly|plan)/gi, '').trim();
  const serviceName = titleWords || item.title;

  const checklist: string[] = [
    `Log into your official ${serviceName} account settings or billing dashboard directly.`,
    'Navigate to "Subscriptions", "Manage Plan", or "Payment & Billing".',
    'Select "Cancel Subscription" or "Turn off Auto-Renew" before the deadline.',
    'Save or screenshot the cancellation confirmation page and cancellation reference ID.',
    'Check your inbox for a cancellation confirmation email and archive it in Anchor.',
  ];

  return {
    isSubscription: isSub,
    serviceName,
    renewalDate: item.dueAt,
    checklist,
  };
}
