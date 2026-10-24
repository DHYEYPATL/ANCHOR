let failedAttempts = 0;
let lockoutUntil = 0;

export interface UnlockThrottleState {
  isLockedOut: boolean;
  remainingMs: number;
  failedAttempts: number;
}

/**
 * Calculates exponential backoff delay based on repeated failed unlock attempts.
 * Protects local vault keys against offline password guessing or script brute-forcing.
 */
export function recordFailedUnlock(): UnlockThrottleState {
  failedAttempts++;
  let delayMs = 0;
  if (failedAttempts >= 5) {
    delayMs = Math.min(30_000, 2 ** (failedAttempts - 4) * 2000);
  } else if (failedAttempts >= 3) {
    delayMs = (failedAttempts - 2) * 1000;
  }
  lockoutUntil = Date.now() + delayMs;
  return getUnlockThrottleState();
}

export function recordSuccessfulUnlock(): void {
  failedAttempts = 0;
  lockoutUntil = 0;
}

export function getUnlockThrottleState(): UnlockThrottleState {
  const now = Date.now();
  const remaining = Math.max(0, lockoutUntil - now);
  return {
    isLockedOut: remaining > 0,
    remainingMs: remaining,
    failedAttempts,
  };
}

/**
 * Configures an inactivity monitor that invokes `onTimeout` after a specified period of no user interaction.
 * Supports desktop mouse/keyboard and mobile touch events.
 */
export function createInactivityMonitor(
  onTimeout: () => void,
  timeoutMinutes = 15,
  lockOnBackground = false
): { destroy: () => void; touchActivity: () => void } {
  let timer: number | undefined;
  const timeoutMs = timeoutMinutes * 60 * 1000;

  const resetTimer = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      onTimeout();
    }, timeoutMs);
  };

  const onVisibilityChange = () => {
    if (lockOnBackground && document.visibilityState === 'hidden') {
      onTimeout();
    }
  };

  const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
  const listener = () => resetTimer();

  events.forEach((evt) => window.addEventListener(evt, listener, { passive: true }));
  document.addEventListener('visibilitychange', onVisibilityChange);

  resetTimer();

  return {
    destroy: () => {
      if (timer !== undefined) window.clearTimeout(timer);
      events.forEach((evt) => window.removeEventListener(evt, listener));
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
    touchActivity: () => resetTimer(),
  };
}
