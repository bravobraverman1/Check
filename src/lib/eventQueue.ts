// ============================================================
// Event Queue — serialises ALL Google Sheets event writes so
// they never fire concurrently or faster than COOLDOWN_MS apart.
// This prevents Apps Script "collision events" where multiple
// onChange triggers race against each other.
// ============================================================

const COOLDOWN_MS = 750; // short debounce for accidental double-clicks; true concurrency control is server-side locks

type QueuedTask<T> = {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _queue: QueuedTask<any>[] = [];
let _running = false;
let _lastCallEnd = 0;

async function _processQueue() {
  if (_running) return;
  _running = true;

  while (_queue.length > 0) {
    const task = _queue.shift()!;

    // Enforce minimum gap since the LAST call finished
    const elapsed = Date.now() - _lastCallEnd;
    if (elapsed < COOLDOWN_MS) {
      await sleep(COOLDOWN_MS - elapsed);
    }

    try {
      const result = await task.fn();
      _lastCallEnd = Date.now();
      task.resolve(result);
    } catch (err) {
      _lastCallEnd = Date.now();
      task.reject(err);
    }
  }

  _running = false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enqueue an async function so it runs sequentially with a
 * minimum cooldown between calls. Returns a promise that
 * resolves/rejects with the function's result.
 *
 * Usage:
 *   const result = await enqueueEvent(() => logDockDelete(sku));
 */
export function enqueueEvent<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    _queue.push({ fn, resolve, reject });
    _processQueue();
  });
}
