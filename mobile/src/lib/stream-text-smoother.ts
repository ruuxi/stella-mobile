const STREAM_REVEAL_INTERVAL_MS = 24;
const STREAM_BASE_CHARS_PER_TICK = 2;
const STREAM_FAST_CHARS_PER_TICK = 6;
const STREAM_FAST_BACKLOG_CHARS = 160;

type StreamTextSmootherOptions = {
  appendText: (text: string) => void;
};

export type StreamTextSmoother = {
  push: (delta: string) => void;
  drain: () => Promise<void>;
  flushNow: () => void;
  cancel: () => void;
};

export function createStreamTextSmoother({
  appendText,
}: StreamTextSmootherOptions): StreamTextSmoother {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const drainWaiters = new Set<() => void>();

  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  const resolveDrainWaiters = () => {
    if (pending.length > 0 || timer) return;
    const waiters = Array.from(drainWaiters);
    drainWaiters.clear();
    for (const resolve of waiters) resolve();
  };

  const schedule = () => {
    if (cancelled || timer || pending.length === 0) return;
    timer = setTimeout(tick, STREAM_REVEAL_INTERVAL_MS);
  };

  const tick = () => {
    timer = null;
    if (cancelled || pending.length === 0) {
      resolveDrainWaiters();
      return;
    }

    const take =
      pending.length >= STREAM_FAST_BACKLOG_CHARS
        ? STREAM_FAST_CHARS_PER_TICK
        : STREAM_BASE_CHARS_PER_TICK;
    const next = pending.slice(0, take);
    pending = pending.slice(take);
    appendText(next);
    schedule();
    resolveDrainWaiters();
  };

  return {
    push(delta: string) {
      if (cancelled || delta.length === 0) return;
      pending += delta;
      schedule();
    },
    drain() {
      if (cancelled || pending.length === 0) {
        clearTimer();
        return Promise.resolve();
      }
      schedule();
      return new Promise<void>((resolve) => {
        drainWaiters.add(resolve);
        resolveDrainWaiters();
      });
    },
    flushNow() {
      clearTimer();
      if (cancelled || pending.length === 0) {
        resolveDrainWaiters();
        return;
      }
      const next = pending;
      pending = "";
      appendText(next);
      resolveDrainWaiters();
    },
    cancel() {
      cancelled = true;
      pending = "";
      clearTimer();
      resolveDrainWaiters();
    },
  };
}
