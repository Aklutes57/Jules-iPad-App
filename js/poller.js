// poller.js — a well-behaved repeating task.
//
// Rules it enforces so the rest of the app doesn't have to:
//   * chained setTimeout, never setInterval — two ticks can never overlap
//   * paused while the tab is hidden or the device is offline
//   * resumed (immediately, not after a full interval) when either comes back
//   * exponential slow-down after consecutive failures, capped, reset on success
//
// Why it matters here: this is an iPad app that will sit in a background Safari
// tab for hours. A naive interval would hammer a rate-limited API and drain the
// battery for nothing.

const MAX_ERROR_INTERVAL_MS = 60000;

/**
 * @param {{tick: () => (Promise<void>|void),
 *          getInterval: () => number,
 *          onError?: (err: Error, consecutiveFailures: number) => void,
 *          immediate?: boolean}} options
 * @returns {{start: () => void, stop: () => void, kick: () => void, isRunning: () => boolean}}
 */
export function createPoller(options) {
  const tick = options.tick;
  const getInterval = options.getInterval || (() => 15000);
  const onError = options.onError || null;
  const immediate = options.immediate !== false;

  let running = false;
  let timer = null;
  let inFlight = false;
  let failures = 0;
  let listening = false;

  function paused() {
    if (typeof document !== 'undefined' && document.hidden) return true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return false;
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function nextDelay() {
    let base = Number(getInterval());
    if (!Number.isFinite(base) || base < 250) base = 250;
    if (failures > 0) {
      base = Math.min(base * Math.pow(2, failures), MAX_ERROR_INTERVAL_MS);
    }
    return base;
  }

  function schedule() {
    clearTimer();
    if (!running || paused()) return;
    timer = setTimeout(run, nextDelay());
  }

  async function run() {
    timer = null;
    if (!running || inFlight) return;
    if (paused()) return; // resumed by the visibility / online listeners

    inFlight = true;
    try {
      await tick();
      failures = 0;
    } catch (err) {
      if (!err || err.name !== 'AbortError') {
        failures += 1;
        if (onError) {
          try {
            onError(err, failures);
          } catch (_e) {
            /* A broken error handler must not kill the poller. */
          }
        }
      }
    } finally {
      inFlight = false;
      schedule();
    }
  }

  function onWake() {
    if (!running) return;
    if (paused()) {
      clearTimer();
      return;
    }
    kick();
  }

  function addListeners() {
    if (listening) return;
    listening = true;
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    window.addEventListener('offline', onWake);
  }

  function removeListeners() {
    if (!listening) return;
    listening = false;
    document.removeEventListener('visibilitychange', onWake);
    window.removeEventListener('online', onWake);
    window.removeEventListener('offline', onWake);
  }

  function start() {
    if (running) return;
    running = true;
    failures = 0;
    addListeners();
    if (immediate) run();
    else schedule();
  }

  function stop() {
    running = false;
    clearTimer();
    removeListeners();
  }

  /** Run right now (unless a tick is already in flight or we're paused). */
  function kick() {
    if (!running || inFlight || paused()) return;
    clearTimer();
    run();
  }

  return {
    start,
    stop,
    kick,
    isRunning: () => running,
  };
}
