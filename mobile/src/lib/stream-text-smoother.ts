/**
 * Frame-paced reveal of streamed assistant chat text.
 *
 * Provider deltas arrive in bursts (one token, then a 40-char clump, then a
 * stall), so appending each delta 1:1 to the rendered message makes the text
 * lurch. This smoother buffers inbound text and meters it out on a
 * requestAnimationFrame loop so reveals land on display-refresh boundaries
 * (smoother than a free-running `setTimeout`). The release rate is adaptive: a
 * steady floor of a couple code points per frame while the buffer is small,
 * scaling up so any backlog drains within a fixed number of frames. The buffer
 * therefore can never lag meaningfully behind the model, yet a slow trickle
 * still reads as smooth typing.
 *
 * Mirrors desktop's `useStreamTextPacer`. Splits on code points so a surrogate
 * pair (emoji) is never revealed half-formed mid-frame.
 */

/** Steady floor of code points released per frame while the buffer is non-empty. */
const STREAM_MIN_CHARS_PER_FRAME = 2;
/** Any backlog drains over at most this many frames (~100ms at 60fps). */
const STREAM_CATCH_UP_FRAMES = 6;

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
  // Buffered code points awaiting reveal. Kept as an array so we never re-scan
  // the whole pending string for surrogate pairs every frame.
  let pending: string[] = [];
  let frame: ReturnType<typeof requestAnimationFrame> | null = null;
  let cancelled = false;
  const drainWaiters = new Set<() => void>();

  const clearFrame = () => {
    if (frame === null) return;
    cancelAnimationFrame(frame);
    frame = null;
  };

  const resolveDrainWaiters = () => {
    if (pending.length > 0 || frame !== null) return;
    const waiters = Array.from(drainWaiters);
    drainWaiters.clear();
    for (const resolve of waiters) resolve();
  };

  const schedule = () => {
    if (cancelled || frame !== null || pending.length === 0) return;
    frame = requestAnimationFrame(tick);
  };

  const tick = () => {
    frame = null;
    if (cancelled || pending.length === 0) {
      resolveDrainWaiters();
      return;
    }

    // Steady floor, scaling up so the current backlog clears within
    // STREAM_CATCH_UP_FRAMES — bursts catch up fast, trickles stay gentle.
    const take = Math.max(
      STREAM_MIN_CHARS_PER_FRAME,
      Math.ceil(pending.length / STREAM_CATCH_UP_FRAMES),
    );
    const next = pending.slice(0, take).join("");
    pending = pending.slice(take);
    appendText(next);
    schedule();
    resolveDrainWaiters();
  };

  return {
    push(delta: string) {
      if (cancelled || delta.length === 0) return;
      // Spread to code points so multi-unit glyphs never split across frames.
      for (const ch of delta) pending.push(ch);
      schedule();
    },
    drain() {
      if (cancelled || pending.length === 0) {
        clearFrame();
        return Promise.resolve();
      }
      schedule();
      return new Promise<void>((resolve) => {
        drainWaiters.add(resolve);
        resolveDrainWaiters();
      });
    },
    flushNow() {
      clearFrame();
      if (cancelled || pending.length === 0) {
        resolveDrainWaiters();
        return;
      }
      const next = pending.join("");
      pending = [];
      appendText(next);
      resolveDrainWaiters();
    },
    cancel() {
      cancelled = true;
      pending = [];
      clearFrame();
      resolveDrainWaiters();
    },
  };
}
