// Mobile port of `desktop/src/shell/ascii-creature/StellaAnimation.tsx`.
//
// Renders the same WebGL fragment-shader Stella creature inside an `expo-gl`
// `GLView`. Voice/analyser plumbing from the desktop version is stripped — on
// mobile this component currently only services the working indicator and
// onboarding hero animation, neither of which needs mic / output energy.

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { StyleSheet, View } from "react-native";
import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import { useColors } from "../../theme/theme-context";
import { type Colors } from "../../theme/colors";
import {
  BIRTH_DURATION,
  FLASH_DURATION,
  buildGlyphAtlas,
  parseColor,
} from "./glyph-atlas";
import { initRenderer, type StellaRenderer } from "./renderer";

const TIME_RATE = 0.96;

export interface StellaAnimationHandle {
  triggerFlash: () => void;
  startBirth: () => void;
  reset: (value?: number) => void;
}

export interface StellaAnimationProps {
  /** Visible width in pt — sizes the on-screen container only. */
  width?: number;
  /** Visible height in pt — sizes the on-screen container only. */
  height?: number;
  /**
   * Dot grid columns. Independent of `width`: a small indicator with `width=56`
   * looks right with `columns ≈ 18`. The desktop equivalent uses 80.
   */
  columns?: number;
  /** Dot grid rows. */
  rows?: number;
  /** Birth progress at mount: 1 = fully born, 0 = unborn. */
  initialBirthProgress?: number;
  /** Pause the animation loop. */
  paused?: boolean;
}

const colorsToFloat = (c: Colors): Float32Array =>
  new Float32Array([
    ...parseColor(c.borderStrong),
    ...parseColor(c.textMuted),
    ...parseColor(c.accent),
    ...parseColor(c.accentHover),
    ...parseColor(c.text),
  ]);

export const StellaAnimation = React.forwardRef<
  StellaAnimationHandle,
  StellaAnimationProps
>(function StellaAnimation(
  {
    width = 56,
    height = 32,
    columns = 18,
    rows = 12,
    initialBirthProgress = 1,
    paused = false,
  },
  ref,
) {
  const colors = useColors();
  const colorsRef = useRef(colors);
  colorsRef.current = colors;

  const rendererRef = useRef<StellaRenderer | null>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const animateRef = useRef<(() => void) | null>(null);
  const pausedRef = useRef(paused);
  const timeRef = useRef(0);
  const lastFrameMsRef = useRef(0);
  const birthRef = useRef(initialBirthProgress);
  const flashRef = useRef(0);
  const birthAnimRef = useRef<{
    startMs: number;
    startValue: number;
    duration: number;
  } | null>(null);
  const flashAnimRef = useRef<{ startMs: number; duration: number } | null>(
    null,
  );

  useImperativeHandle(
    ref,
    () => ({
      triggerFlash: () => {
        flashAnimRef.current = {
          startMs: nowMs(),
          duration: FLASH_DURATION,
        };
        flashRef.current = 1;
      },
      startBirth: () => {
        if (birthRef.current >= 1) return;
        birthAnimRef.current = {
          startMs: nowMs(),
          startValue: birthRef.current,
          duration: BIRTH_DURATION,
        };
      },
      reset: (value = initialBirthProgress) => {
        birthRef.current = value;
        birthAnimRef.current = null;
        flashRef.current = 0;
        flashAnimRef.current = null;
      },
    }),
    [initialBirthProgress],
  );

  // Push fresh colors into the renderer whenever the theme changes without
  // tearing down the GL context.
  useEffect(() => {
    rendererRef.current?.setColors(colorsToFloat(colors));
  }, [colors]);

  // Pause/resume the rAF loop in response to the `paused` prop.
  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = undefined;
      }
      lastFrameMsRef.current = 0;
      return;
    }
    if (rafRef.current === undefined && animateRef.current) {
      rafRef.current = requestAnimationFrame(animateRef.current);
    }
  }, [paused]);

  const gridW = Math.max(6, Math.round(columns));
  const gridH = Math.max(4, Math.round(rows));

  const onContextCreate = useCallback(
    (gl: ExpoWebGLRenderingContext) => {
      const bufferW = gl.drawingBufferWidth;
      const bufferH = gl.drawingBufferHeight;
      // Each grid cell maps 1:1 to a glyph atlas slot on screen, so the
      // atlas glyph size = device pixels per grid cell. Floor to integers
      // and clamp so a degenerate buffer size still produces a readable
      // atlas (dot radius needs ~3px to be visible).
      const glyphWidth = Math.max(4, Math.floor(bufferW / gridW));
      const glyphHeight = Math.max(4, Math.floor(bufferH / gridH));

      const atlas = buildGlyphAtlas(glyphWidth, glyphHeight);
      const renderer = initRenderer(
        gl,
        atlas,
        gridW,
        gridH,
        colorsToFloat(colorsRef.current),
        birthRef.current,
        flashRef.current,
      );
      if (!renderer) return;
      rendererRef.current = renderer;

      // Initial frame so a paused mount still shows the creature.
      renderer.render(timeRef.current, birthRef.current, flashRef.current);

      const animate = () => {
        if (pausedRef.current) {
          rafRef.current = undefined;
          lastFrameMsRef.current = 0;
          return;
        }
        const now = nowMs();
        const dt =
          lastFrameMsRef.current > 0
            ? Math.min(now - lastFrameMsRef.current, 100)
            : 16.667;
        lastFrameMsRef.current = now;
        timeRef.current += (dt / 1000) * TIME_RATE;

        const birthAnim = birthAnimRef.current;
        if (birthAnim) {
          const t = Math.min(
            (now - birthAnim.startMs) / birthAnim.duration,
            1,
          );
          const eased = 1 - Math.pow(1 - t, 3);
          birthRef.current =
            birthAnim.startValue + (1 - birthAnim.startValue) * eased;
          if (t >= 1) birthAnimRef.current = null;
        }

        const flashAnim = flashAnimRef.current;
        if (flashAnim) {
          const t = Math.min(
            (now - flashAnim.startMs) / flashAnim.duration,
            1,
          );
          flashRef.current = 1 - t;
          if (t >= 1) {
            flashRef.current = 0;
            flashAnimRef.current = null;
          }
        }

        renderer.render(timeRef.current, birthRef.current, flashRef.current);
        rafRef.current = requestAnimationFrame(animate);
      };

      animateRef.current = animate;
      if (!pausedRef.current) {
        rafRef.current = requestAnimationFrame(animate);
      }
    },
    [gridW, gridH],
  );

  // Clean up on unmount — GLView itself destroys the context, but we still
  // cancel any pending frame and drop refs.
  useEffect(() => {
    return () => {
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = undefined;
      animateRef.current = null;
      const renderer = rendererRef.current;
      rendererRef.current = null;
      if (renderer) {
        try {
          renderer.destroy();
        } catch {
          // GL context may already be gone — safe to ignore.
        }
      }
    };
  }, []);

  const containerStyle = useMemo(
    () => [styles.container, { width, height }],
    [width, height],
  );

  return (
    <View style={containerStyle} pointerEvents="none">
      <GLView style={styles.gl} onContextCreate={onContextCreate} />
    </View>
  );
});

const nowMs = (): number => {
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.performance?.now === "function"
  ) {
    return globalThis.performance.now();
  }
  return Date.now();
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: "transparent",
  },
  gl: {
    width: "100%",
    height: "100%",
    backgroundColor: "transparent",
  },
});
