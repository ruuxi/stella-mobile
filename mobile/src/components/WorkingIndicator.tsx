import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
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
import { fadeHex } from "../theme/oklch";
import { fonts } from "../theme/fonts";

const indicatorLayout = getWorkingIndicatorLayout();
const ENTER_DURATION_MS = 320;
const EXIT_HOLD_MS = 300;
const EXIT_ANIMATION_MS = 480;
const SWAP_DURATION_MS = 240;

/** Fixed slot height — reserved above the composer (padding + circular viewport). */
export const WORKING_INDICATOR_SLOT_HEIGHT =
  6 + indicatorLayout.viewport + 4;

interface WorkingIndicatorProps {
  /** When true, the indicator is visible and the creature animates. */
  active: boolean;
  /** Optional explicit status. Defaults to the same reasoning copy as desktop. */
  status?: string;
  toolName?: string;
  toolCallId?: string;
  isReasoning?: boolean;
}

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

  useEffect(() => {
    if (!active) {
      shimmer.stopAnimation();
      shimmer.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 1350,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, shimmer]);

  const shimmerStyle = useMemo(
    () => ({
      opacity: shimmer.interpolate({
        inputRange: [0, 0.35, 0.65, 1],
        outputRange: [0, 0.4, 0.4, 0],
      }),
      transform: [
        {
          translateX: shimmer.interpolate({
            inputRange: [0, 1],
            outputRange: [-36, 72],
          }),
        },
      ],
    }),
    [shimmer],
  );

  return (
    <View style={styles.shimmerWrap}>
      <Text
        style={styles.statusText}
        numberOfLines={1}
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
      >
        {text}
      </Text>
      {active ? (
        <Animated.Text
          style={[
            styles.statusText,
            styles.statusShimmer,
            { color: colors.accent },
            shimmerStyle,
          ]}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {text}
        </Animated.Text>
      ) : null}
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
 * The GLView is never animated through parent opacity. On iOS that can make
 * UIKit snapshot and freeze the GL surface, so entrance/exit motion uses
 * transform only and the row is unmounted after the desktop-matched hold.
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
    () => ({
      transform: [
        {
          translateY: shellProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [-2, 0],
          }),
        },
        {
          scale: shellProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [0.92, 1],
          }),
        },
      ],
    }),
    [shellProgress],
  );

  return (
    <View style={styles.slot} pointerEvents="none">
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
                frameSkip={1}
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
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      height: WORKING_INDICATOR_SLOT_HEIGHT,
      justifyContent: "flex-start",
      paddingBottom: 4,
      paddingHorizontal: 24,
      paddingTop: 6,
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
      overflow: "hidden",
    },
    statusText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.1,
      lineHeight: 20,
    },
    statusShimmer: {
      bottom: 0,
      left: 0,
      opacity: 0,
      position: "absolute",
      right: 0,
      textShadowColor: fadeHex(colors.accent, 0.5),
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 8,
      top: 0,
    },
  });
