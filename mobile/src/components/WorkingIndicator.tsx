import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { fadeHex } from "../theme/oklch";
import {
  StellaAnimation,
  WORKING_INDICATOR_DISPLAY_PT,
  WORKING_INDICATOR_GRID,
  getWorkingIndicatorLayout,
} from "./stella-animation";
import { computeWorkingIndicatorStatus } from "./working-indicator-status";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

const indicatorLayout = getWorkingIndicatorLayout();
const ENTER_DURATION_MS = 320;
const EXIT_HOLD_MS = 300;
const EXIT_ANIMATION_MS = 480;
const SWAP_DURATION_MS = 240;
const INDICATOR_PAD_TOP = 0;
const INDICATOR_PAD_BOTTOM = 0;

/**
 * Reserved vertical space above the composer. Intentionally smaller than the
 * creature viewport — the row is `overflow: visible`, so the creature extends
 * a few pt above and below the slot, letting us claim less layout space while
 * keeping Stella at her chosen size.
 */
export const WORKING_INDICATOR_SLOT_HEIGHT = Math.round(
  indicatorLayout.viewport * 0.6,
);

interface WorkingIndicatorProps {
  /** When true, the indicator is visible and the creature animates. */
  active: boolean;
  /** Optional explicit status. Defaults to the same reasoning copy as desktop. */
  status?: string;
  toolName?: string;
  toolCallId?: string;
  isReasoning?: boolean;
}

const SHIMMER_DURATION_MS = 1600;
// Strip is wider than the text so the bright peak fully exits before looping.
const SHIMMER_GRADIENT_MULTIPLIER = 3;
// Brightness range of the gradient stops. Tails almost vanish; peak is fully
// opaque — yields a clearly visible sweeping highlight rather than a subtle
// breath.
const SHIMMER_DIM_ALPHA = 0.15;
const SHIMMER_PEAK_ALPHA = 1;

function ShimmerText({
  text,
  active,
  colors,
  styles,
}: {
  text: string;
  active: boolean;
  colors: Colors;
  styles: ReturnType<typeof makeStyles>;
}) {
  const shimmer = useRef(new Animated.Value(0)).current;
  const [textWidth, setTextWidth] = useState(0);

  useEffect(() => {
    if (!active || textWidth === 0) {
      shimmer.stopAnimation();
      shimmer.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: SHIMMER_DURATION_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, shimmer, textWidth]);

  const gradientWidth = Math.max(1, textWidth * SHIMMER_GRADIENT_MULTIPLIER);
  // Slide the strip from x=-(gradientWidth - textWidth) (visible window
  // shows the strip's right tail) toward x=0 (visible window shows the
  // strip's left tail). The dim trough in the middle of the strip therefore
  // crosses the visible mask region left → right exactly once per loop.
  const gradientTranslate = useMemo(
    () =>
      shimmer.interpolate({
        inputRange: [0, 1],
        outputRange: [-(gradientWidth - textWidth), 0],
      }),
    [shimmer, gradientWidth, textWidth],
  );

  const dimColor = fadeHex(colors.text, SHIMMER_DIM_ALPHA);
  const peakColor = fadeHex(colors.text, SHIMMER_PEAK_ALPHA);

  // Measurement pass — render once invisibly so onLayout fires, then we can
  // size the masked gradient correctly on the next render.
  if (textWidth === 0) {
    return (
      <View style={styles.shimmerWrap}>
        <Text
          style={[styles.statusText, styles.shimmerMeasure]}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}
        >
          {text}
        </Text>
      </View>
    );
  }

  if (!active) {
    return (
      <View style={styles.shimmerWrap}>
        <Text
          style={styles.statusText}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}
        >
          {text}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.shimmerWrap}>
      <MaskedView
        style={{ height: 20, width: textWidth }}
        maskElement={
          <View style={styles.shimmerMaskHost}>
            <Text
              style={styles.statusText}
              numberOfLines={1}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              onLayout={(e) => setTextWidth(e.nativeEvent.layout.width)}
            >
              {text}
            </Text>
          </View>
        }
      >
        <Animated.View
          pointerEvents="none"
          style={{
            width: gradientWidth,
            height: 20,
            transform: [{ translateX: gradientTranslate }],
          }}
        >
          <LinearGradient
            colors={[peakColor, peakColor, dimColor, peakColor, peakColor]}
            locations={[0, 0.4, 0.5, 0.6, 1]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </MaskedView>
    </View>
  );
}

function SwapText({
  text,
  active,
  colors,
  styles,
}: {
  text: string;
  active: boolean;
  colors: Colors;
  styles: ReturnType<typeof makeStyles>;
}) {
  const [current, setCurrent] = useState(text);
  const [previous, setPrevious] = useState<string | null>(null);
  const lastTextRef = useRef(text);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inValue = useRef(new Animated.Value(1)).current;
  const outValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (text === lastTextRef.current) return;

    const old = lastTextRef.current;
    setPrevious(old);
    setCurrent(text);
    lastTextRef.current = text;
    inValue.setValue(0);
    outValue.setValue(1);

    Animated.parallel([
      Animated.timing(inValue, {
        toValue: 1,
        duration: SWAP_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(outValue, {
        toValue: 0,
        duration: SWAP_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setPrevious(null);
      timeoutRef.current = null;
    }, SWAP_DURATION_MS);

    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [inValue, outValue, text]);

  const inStyle = useMemo(
    () => ({
      opacity: inValue,
      transform: [
        {
          translateY: inValue.interpolate({
            inputRange: [0, 1],
            outputRange: [4, 0],
          }),
        },
      ],
    }),
    [inValue],
  );
  const outStyle = useMemo(
    () => ({
      opacity: outValue,
      transform: [
        {
          translateY: outValue.interpolate({
            inputRange: [0, 1],
            outputRange: [-4, 0],
          }),
        },
      ],
    }),
    [outValue],
  );

  return (
    <View style={styles.swapText}>
      {previous ? (
        <Animated.View style={[styles.swapLayer, outStyle]} pointerEvents="none">
          <ShimmerText
            text={previous}
            active={false}
            colors={colors}
            styles={styles}
          />
        </Animated.View>
      ) : null}
      <Animated.View style={[styles.swapLayer, inStyle]}>
        <ShimmerText text={current} active={active} colors={colors} styles={styles} />
      </Animated.View>
    </View>
  );
}

/**
 * Stella above the composer.
 *
 * Entrance/exit is a plain opacity fade on the whole row, and the row is
 * unmounted after the desktop-matched hold so the GLView never sits invisible
 * in the tree consuming GPU time.
 */
export const WorkingIndicator = memo(function WorkingIndicator({
  active,
  status,
  toolName,
  toolCallId,
  isReasoning = true,
}: WorkingIndicatorProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { viewport, display } = indicatorLayout;
  const displayStatus = computeWorkingIndicatorStatus({
    status,
    toolName,
    seed: toolCallId,
    isReasoning,
  });
  const [renderShell, setRenderShell] = useState(active);
  const shellProgress = useRef(new Animated.Value(active ? 1 : 0)).current;
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearTimers = () => {
      if (holdTimerRef.current !== null) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (leaveTimerRef.current !== null) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
    };

    if (active) {
      clearTimers();
      setRenderShell(true);
      Animated.timing(shellProgress, {
        toValue: 1,
        duration: ENTER_DURATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return clearTimers;
    }

    if (!renderShell) return clearTimers;

    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      Animated.timing(shellProgress, {
        toValue: 0,
        duration: EXIT_ANIMATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      leaveTimerRef.current = setTimeout(() => {
        leaveTimerRef.current = null;
        setRenderShell(false);
      }, EXIT_ANIMATION_MS);
    }, EXIT_HOLD_MS);

    return clearTimers;
  }, [active, renderShell, shellProgress]);

  const shellStyle = useMemo(
    () => ({ opacity: shellProgress }),
    [shellProgress],
  );

  return (
    <View
      style={[styles.slot, !renderShell && styles.slotCollapsed]}
      pointerEvents="none"
    >
      {renderShell ? (
        <Animated.View style={[styles.row, shellStyle]} collapsable={false}>
          <View
            style={[styles.viewport, { width: viewport, height: viewport }]}
            collapsable={false}
          >
            <View
              style={[styles.canvasSlot, { width: display, height: display }]}
              collapsable={false}
            >
              <StellaAnimation
                width={WORKING_INDICATOR_GRID}
                height={WORKING_INDICATOR_GRID}
                displayWidth={WORKING_INDICATOR_DISPLAY_PT}
                displayHeight={WORKING_INDICATOR_DISPLAY_PT}
                frameSkip={2}
                paused={!active}
              />
            </View>
          </View>
          <SwapText
            text={displayStatus}
            active={active}
            colors={colors}
            styles={styles}
          />
        </Animated.View>
      ) : null}
    </View>
  );
});

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    slot: {
      height: WORKING_INDICATOR_SLOT_HEIGHT,
      flexShrink: 0,
      overflow: "visible",
    },
    // Inline at the chat tail the slot must take no space once the indicator
    // has fully left, otherwise it leaves a permanent gap above the composer.
    slotCollapsed: {
      height: 0,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      height: WORKING_INDICATOR_SLOT_HEIGHT,
      justifyContent: "flex-start",
      overflow: "visible",
      paddingBottom: INDICATOR_PAD_BOTTOM,
      paddingHorizontal: 18,
      paddingTop: INDICATOR_PAD_TOP,
    },
    viewport: {
      borderRadius: 999,
      overflow: "hidden",
      position: "relative",
    },
    canvasSlot: {
      alignItems: "center",
      justifyContent: "center",
    },
    swapText: {
      flex: 1,
      height: 20,
      minWidth: 0,
      overflow: "hidden",
    },
    swapLayer: {
      bottom: 0,
      justifyContent: "center",
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    shimmerWrap: {
      justifyContent: "center",
    },
    statusText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.1,
      lineHeight: 20,
    },
    // Invisible measurement copy — needs to render so onLayout fires.
    shimmerMeasure: {
      opacity: 0,
    },
    // MaskedView's mask is drawn into an alpha channel only — color doesn't
    // matter as long as the glyphs are fully opaque.
    shimmerMaskHost: {
      backgroundColor: "transparent",
    },
  });
