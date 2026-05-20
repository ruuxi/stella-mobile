import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActionSheetIOS,
  Alert,
  Animated,
  Dimensions,
  Keyboard,
  LayoutAnimation,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from "react-native";
import {
  FlashList,
  type FlashListRef,
  type ListRenderItemInfo,
} from "@shopify/flash-list";
import { Image } from "expo-image";
import { GlassView } from "expo-glass-effect";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "./Icon";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { DictationRecordingBar } from "./DictationRecordingBar";
import { WorkingIndicator } from "./WorkingIndicator";
import { useDictation } from "../lib/dictation";
import { notifySuccess, tapMedium, tapLight } from "../lib/haptics";
import {
  speakReply,
  useReadAloudPreference,
} from "../lib/read-aloud";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fadeHex } from "../theme/oklch";
import { fonts } from "../theme/fonts";
import type { ChatMessage } from "../types";

// Required for LayoutAnimation on Android.
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ---------------------------------------------------------------------------
// Constants — mapped from desktop full-shell.composer.css
// ---------------------------------------------------------------------------

/**
 * Content-height threshold for pill → expanded.
 * RN `onContentSizeChange` reports raw text height (no padding).
 * fontSize 16 × lineHeight ~22 ≈ 22 per line; trip on the second line so
 * wrapping immediately grows the composer instead of clipping behind the
 * send button.
 */
const EXPAND_THRESHOLD = 30;
/** LayoutAnimation config matching the same 350ms critically-damped spring. */
const LAYOUT_SPRING = {
  duration: 350,
  update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
  create: {
    type: LayoutAnimation.Types.spring,
    springDamping: 1,
    property: LayoutAnimation.Properties.opacity,
  },
  delete: {
    type: LayoutAnimation.Types.spring,
    springDamping: 1,
    property: LayoutAnimation.Properties.opacity,
  },
};

/**
 * Extra breathing room beyond the list's trailing slack (`EDGE_FADE` +
 * measured composer height). The slack is empty scrollable padding so messages
 * can sit above the overlay — without adding it, "near bottom" never engages
 * in the normal reading position (desktop `followRearmThreshold` does the same).
 */
const SCROLL_NEAR_BOTTOM_BASE_PX = 96;
/** Base distance before showing the scroll-to-bottom FAB (plus trailing slack). */
const SCROLL_AWAY_FROM_BOTTOM_BASE_PX = 96;
/**
 * Max cumulative auto-scroll per assistant reply while near the bottom.
 * Mirrors desktop follow stopping once the streaming row reaches the top.
 */
const ASSISTANT_AUTO_SCROLL_MAX_PX = 400;
/**
 * Adaptive auto-follow speed: base feels smooth for steady streams, scales up
 * with how far behind we are so bursty token output catches up without snapping.
 *
 *   speed = clamp(base + pending * scale, base, max)
 */
const ASSISTANT_AUTO_SCROLL_BASE_SPEED_PX_PER_S = 400;
const ASSISTANT_AUTO_SCROLL_MAX_SPEED_PX_PER_S = 1400;
const ASSISTANT_AUTO_SCROLL_SPEED_SCALE_PER_PX = 4;
/** Re-arm capped auto-follow once the user scrolls back to the true bottom. */
const SCROLL_AT_BOTTOM_THRESHOLD = 8;
/** Cap per-frame delta so a long hitch does not teleport the list. */
const ASSISTANT_AUTO_SCROLL_MAX_FRAME_MS = 48;
/** Small upward nudge after send so the user bubble clears room for the reply. */
const POST_SEND_NUDGE_PX = 128;

const EDGE_FADE = 48;
const MESSAGE_LIST_GAP = 20;
/** Cancels the shell `content` padding so chat owns its horizontal inset. */
const SHELL_CONTENT_PADDING = 20;
/** Horizontal inset from the true screen edge once shell padding is cancelled. */
const CHAT_HORIZONTAL_INSET = 12;

// ---------------------------------------------------------------------------
// Keyboard inset — keeps the composer and message list above the OS keyboard.
// ---------------------------------------------------------------------------

function useKeyboardInset() {
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const onShow = (
      e: { endCoordinates: { height: number }; duration?: number },
    ) => {
      if (Platform.OS === "ios") {
        LayoutAnimation.configureNext({
          duration: e.duration ?? 250,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      setHeight(e.endCoordinates.height);
    };

    const onHide = (e: { duration?: number }) => {
      if (Platform.OS === "ios") {
        LayoutAnimation.configureNext({
          duration: e.duration ?? 250,
          update: { type: LayoutAnimation.Types.keyboard },
        });
      }
      setHeight(0);
    };

    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const open = height > 0;
  // When the keyboard is up it covers the home-indicator band; only reserve
  // that inset on the composer while the keyboard is hidden.
  const composerBottomPad = open ? 6 : 6 + insets.bottom;

  return { height, open, composerBottomPad };
}

// ---------------------------------------------------------------------------
// Scroll — manual by default; capped auto-follow while assistant streams in
// near the bottom.
// ---------------------------------------------------------------------------

function useChatScroll(listTrailingSlackPx: number) {
  const listRef = useRef<FlashListRef<ChatMessage>>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const nearBottomLimit = SCROLL_NEAR_BOTTOM_BASE_PX + listTrailingSlackPx;
  const atBottomLimit = SCROLL_AT_BOTTOM_THRESHOLD + listTrailingSlackPx;
  const awayFromBottomLimit =
    SCROLL_AWAY_FROM_BOTTOM_BASE_PX + listTrailingSlackPx;
  const metricsRef = useRef({ offsetY: 0, contentHeight: 0, layoutHeight: 0 });
  const contentHeightRef = useRef(0);
  const autoScrollUsedRef = useRef(0);
  const followArmedRef = useRef(true);
  const pendingScrollPxRef = useRef(0);
  const followRafRef = useRef(0);
  const lastFollowFrameMsRef = useRef(0);
  /** Content height before the next assistant-driven layout pass. */
  const assistantLayoutBaselineRef = useRef<number | null>(null);

  const stopFollowLoop = useCallback(() => {
    if (followRafRef.current) {
      cancelAnimationFrame(followRafRef.current);
      followRafRef.current = 0;
    }
    lastFollowFrameMsRef.current = 0;
  }, []);

  useEffect(() => () => stopFollowLoop(), [stopFollowLoop]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      metricsRef.current = {
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        layoutHeight: layoutMeasurement.height,
      };
      contentHeightRef.current = contentSize.height;

      const hasOverflow = contentSize.height > layoutMeasurement.height + 2;
      const distFromBottom = Math.max(
        0,
        contentSize.height -
          contentOffset.y -
          layoutMeasurement.height,
      );

      // Re-arm the follow latch (not the per-reply budget!) when the user
      // returns into the reading zone — the budget should only reset on real
      // lifecycle events (new assistant message, manual scroll-to-bottom), or
      // every auto-scroll tick would zero it out via the trailing-slack band.
      if (distFromBottom <= atBottomLimit) {
        followArmedRef.current = true;
      } else if (distFromBottom > nearBottomLimit) {
        followArmedRef.current = false;
        pendingScrollPxRef.current = 0;
        stopFollowLoop();
      }

      setAwayFromBottom(
        hasOverflow && distFromBottom > awayFromBottomLimit,
      );
    },
    [atBottomLimit, awayFromBottomLimit, nearBottomLimit, stopFollowLoop],
  );

  const resetAssistantAutoScroll = useCallback(() => {
    autoScrollUsedRef.current = 0;
    followArmedRef.current = true;
    assistantLayoutBaselineRef.current = null;
    pendingScrollPxRef.current = 0;
    stopFollowLoop();
  }, [stopFollowLoop]);

  /** Call when assistant text grows, before layout measures the new height. */
  const prepareAssistantLayoutFollow = useCallback(() => {
    assistantLayoutBaselineRef.current = contentHeightRef.current;
  }, []);

  const stepFollowLoop = useCallback((now: number) => {
    followRafRef.current = 0;

    if (!followArmedRef.current || pendingScrollPxRef.current <= 0) {
      pendingScrollPxRef.current = 0;
      return;
    }

    const { offsetY, layoutHeight } = metricsRef.current;
    const contentHeight = contentHeightRef.current;
    const distFromBottom = Math.max(
      0,
      contentHeight - offsetY - layoutHeight,
    );
    if (distFromBottom > nearBottomLimit) {
      pendingScrollPxRef.current = 0;
      return;
    }

    const budgetRemaining =
      ASSISTANT_AUTO_SCROLL_MAX_PX - autoScrollUsedRef.current;
    if (budgetRemaining <= 0) {
      followArmedRef.current = false;
      pendingScrollPxRef.current = 0;
      return;
    }

    const lastMs = lastFollowFrameMsRef.current;
    const elapsedMs =
      lastMs === 0
        ? 16
        : Math.min(Math.max(0, now - lastMs), ASSISTANT_AUTO_SCROLL_MAX_FRAME_MS);
    lastFollowFrameMsRef.current = now;

    const adaptiveSpeed = Math.min(
      ASSISTANT_AUTO_SCROLL_MAX_SPEED_PX_PER_S,
      ASSISTANT_AUTO_SCROLL_BASE_SPEED_PX_PER_S +
        pendingScrollPxRef.current * ASSISTANT_AUTO_SCROLL_SPEED_SCALE_PER_PX,
    );
    const maxStep = (adaptiveSpeed * elapsedMs) / 1000;
    const step = Math.min(pendingScrollPxRef.current, budgetRemaining, maxStep);
    if (step <= 0) {
      followRafRef.current = requestAnimationFrame(stepFollowLoop);
      return;
    }

    pendingScrollPxRef.current -= step;
    autoScrollUsedRef.current += step;
    if (autoScrollUsedRef.current >= ASSISTANT_AUTO_SCROLL_MAX_PX) {
      followArmedRef.current = false;
      pendingScrollPxRef.current = 0;
    }

    const maxOffset = Math.max(0, contentHeight - layoutHeight);
    const newOffset = Math.min(offsetY + step, maxOffset);
    metricsRef.current.offsetY = newOffset;
    listRef.current?.scrollToOffset({ offset: newOffset, animated: false });

    const nextDistFromBottom = Math.max(
      0,
      contentHeight - newOffset - layoutHeight,
    );
    setAwayFromBottom(
      contentHeight > layoutHeight + 2 &&
        nextDistFromBottom > awayFromBottomLimit,
    );

    if (pendingScrollPxRef.current > 0 && followArmedRef.current) {
      followRafRef.current = requestAnimationFrame(stepFollowLoop);
    }
  }, [awayFromBottomLimit, nearBottomLimit]);

  const followAssistantContentGrowth = useCallback(
    (growthPx: number) => {
      if (growthPx <= 0 || !followArmedRef.current) return;

      const { offsetY, layoutHeight } = metricsRef.current;
      const contentHeight = contentHeightRef.current;
      const distFromBottom = Math.max(
        0,
        contentHeight - offsetY - layoutHeight,
      );
      if (distFromBottom > nearBottomLimit) return;

      const budgetRemaining =
        ASSISTANT_AUTO_SCROLL_MAX_PX -
        autoScrollUsedRef.current -
        pendingScrollPxRef.current;
      if (budgetRemaining <= 0) {
        followArmedRef.current = false;
        return;
      }

      pendingScrollPxRef.current += Math.min(growthPx, budgetRemaining);
      if (!followRafRef.current) {
        followRafRef.current = requestAnimationFrame(stepFollowLoop);
      }
    },
    [nearBottomLimit, stepFollowLoop],
  );

  const onListContentSizeChange = useCallback(
    (_width: number, height: number) => {
      contentHeightRef.current = height;
      metricsRef.current.contentHeight = height;

      const baseline = assistantLayoutBaselineRef.current;
      if (baseline === null || height <= baseline) return;

      const growth = height - baseline;
      assistantLayoutBaselineRef.current = null;
      followAssistantContentGrowth(growth);
    },
    [followAssistantContentGrowth],
  );

  const scrollToBottom = useCallback(() => {
    resetAssistantAutoScroll();
    requestAnimationFrame(() =>
      listRef.current?.scrollToEnd({ animated: true }),
    );
  }, [resetAssistantAutoScroll]);

  /**
   * After send, bump the viewport slightly when the user is already near the
   * bottom — mirrors desktop `nudgeAfterSend` / `POST_SEND_USER_MESSAGE_BREATHING_PX`.
   */
  const nudgeAfterSend = useCallback(() => {
    const { offsetY, layoutHeight } = metricsRef.current;
    const contentHeight = contentHeightRef.current;
    const distFromBottom = Math.max(
      0,
      contentHeight - offsetY - layoutHeight,
    );
    if (distFromBottom > nearBottomLimit) return;

    followArmedRef.current = true;
    autoScrollUsedRef.current = 0;
    pendingScrollPxRef.current = 0;
    stopFollowLoop();

    const applyNudge = () => {
      const metrics = metricsRef.current;
      const height = contentHeightRef.current;
      const dist = Math.max(
        0,
        height - metrics.offsetY - metrics.layoutHeight,
      );
      if (dist > nearBottomLimit) return;

      const maxOffset = Math.max(0, height - metrics.layoutHeight);
      const newOffset = Math.min(metrics.offsetY + POST_SEND_NUDGE_PX, maxOffset);
      metricsRef.current.offsetY = newOffset;
      listRef.current?.scrollToOffset({ offset: newOffset, animated: true });

      const nextDist = Math.max(0, height - newOffset - metrics.layoutHeight);
      setAwayFromBottom(
        height > metrics.layoutHeight + 2 && nextDist > awayFromBottomLimit,
      );
    };

    requestAnimationFrame(() => requestAnimationFrame(applyNudge));
  }, [awayFromBottomLimit, nearBottomLimit, stopFollowLoop]);

  return {
    listRef,
    onScroll,
    onListContentSizeChange,
    scrollToBottom,
    resetAssistantAutoScroll,
    prepareAssistantLayoutFollow,
    nudgeAfterSend,
    awayFromBottom,
  };
}

// ---------------------------------------------------------------------------
// Animated message wrapper — mirrors desktop stream-fade-blur-in.
// ---------------------------------------------------------------------------

function FadeInMessage({ children }: { children: ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(5)).current;

  const animatedStyle = useMemo(
    () => ({ opacity, transform: [{ translateY }] }),
    [opacity, translateY],
  );

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 450,
        useNativeDriver: true,
      }),
      Animated.spring(translateY, {
        toValue: 0,
        damping: 14,
        stiffness: 180,
        mass: 0.8,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  return <Animated.View style={animatedStyle}>{children}</Animated.View>;
}

const copyAssistantMessage = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  void Clipboard.setStringAsync(trimmed).then((ok) => {
    if (ok) notifySuccess();
  });
};

const shareAssistantMessage = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  void Share.share({ message: trimmed }).catch(() => {});
};

const openAssistantActions = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Copy", "Share\u2026", "Cancel"],
        cancelButtonIndex: 2,
      },
      (index: number) => {
        if (index === 0) copyAssistantMessage(trimmed);
        else if (index === 1) shareAssistantMessage(trimmed);
      },
    );
    return;
  }
  Alert.alert("Message", undefined, [
    { text: "Copy", onPress: () => copyAssistantMessage(trimmed) },
    { text: "Share", onPress: () => shareAssistantMessage(trimmed) },
    { text: "Cancel", style: "cancel" },
  ]);
};

type ChatStyles = ReturnType<typeof makeStyles>;

const ChatMessageRow = memo(function ChatMessageRow({
  item,
  styles,
  colors,
  isStreaming,
}: {
  item: ChatMessage;
  styles: ChatStyles;
  colors: Colors;
  /** True for the trailing assistant message while a reply is mid-stream. */
  isStreaming: boolean;
}) {
  if (item.role === "user") {
    const thumbs = item.thumbnailUris ?? [];
    const showThumbs = thumbs.length > 0;
    const showText = item.text.trim().length > 0;
    return (
      <View style={styles.userRow}>
        <View style={styles.userColumn}>
          <View style={[styles.userBubble, item.queued && styles.userBubbleQueued]}>
            {showThumbs ? (
              <View
                style={[styles.userThumbStrip, showText && styles.userThumbsAbove]}
              >
                {thumbs.slice(0, 3).map((uri) => (
                  <Image
                    key={uri}
                    source={{ uri }}
                    style={styles.userThumbImage}
                    contentFit="cover"
                  />
                ))}
              </View>
            ) : null}
            {showText ? (
              <Text
                style={styles.userText}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {item.text}
              </Text>
            ) : null}
          </View>
          {item.queued ? (
            <Text
              style={styles.queuedTag}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              Queued
            </Text>
          ) : null}
        </View>
      </View>
    );
  }
  return (
    <Pressable
      onLongPress={() => openAssistantActions(item.text)}
      delayLongPress={350}
      accessibilityLabel="Long press for message actions"
      style={styles.assistantRow}
    >
      <AssistantMarkdown
        text={item.text}
        colors={colors}
        isStreaming={isStreaming}
      />
      {item.stopped ? (
        <Text
          style={styles.stoppedTag}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          Stopped
        </Text>
      ) : null}
    </Pressable>
  );
});

/**
 * Submit button that springs between enabled/disabled states like the
 * desktop `motion.button` in `ComposerPrimitives.tsx`:
 *   animate={{ opacity: canSubmit ? 1 : 0.4, scale: canSubmit ? 1 : 0.92 }}
 *   transition={{ type: "spring", duration: 0.2, bounce: 0 }}
 */
function AnimatedSubmitButton({
  canSubmit,
  onPress,
  styles,
  colors,
  accessibilityLabel,
}: {
  canSubmit: boolean;
  onPress: () => void;
  styles: ChatStyles;
  colors: Colors;
  accessibilityLabel: string;
}) {
  const opacity = useRef(new Animated.Value(canSubmit ? 1 : 0.4)).current;
  const scale = useRef(new Animated.Value(canSubmit ? 1 : 0.92)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(opacity, {
        toValue: canSubmit ? 1 : 0.4,
        damping: 18,
        stiffness: 260,
        mass: 0.6,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: canSubmit ? 1 : 0.92,
        damping: 18,
        stiffness: 260,
        mass: 0.6,
        useNativeDriver: true,
      }),
    ]).start();
  }, [canSubmit, opacity, scale]);

  const animatedStyle = useMemo(
    () => ({ opacity, transform: [{ scale }] }),
    [opacity, scale],
  );

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        onPress={onPress}
        disabled={!canSubmit}
        accessibilityLabel={accessibilityLabel}
        style={styles.submitButton}
        hitSlop={4}
      >
        <Icon
          name="arrow-up"
          size={15}
          color={colors.accentForeground}
          weight="heavy"
        />
      </Pressable>
    </Animated.View>
  );
}

/**
 * Square stop affordance shown in place of the submit button while a reply is
 * streaming (chat) or pending (computer chat). Calling `onPress` cancels the
 * in-flight reply AND drops any queued follow-ups — the user explicitly asked
 * to halt the turn, so resuming requires re-sending.
 */
function StopButton({
  onPress,
  styles,
  colors,
}: {
  onPress: () => void;
  styles: ChatStyles;
  colors: Colors;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Stop reply"
      style={styles.submitButton}
      hitSlop={4}
    >
      <Icon
        name="stop"
        size={13}
        color={colors.accentForeground}
        weight="heavy"
        filled
      />
    </Pressable>
  );
}

function ScrollToBottomFab({
  visible,
  hasUnread,
  onPress,
  styles,
  colors,
  bottomOffset,
}: {
  visible: boolean;
  hasUnread: boolean;
  onPress: () => void;
  styles: ChatStyles;
  colors: Colors;
  /** Distance in pt from the bottom of the viewport — sit just above the composer. */
  bottomOffset?: number;
}) {
  if (!visible) return null;
  return (
    <Pressable
      accessibilityLabel={
        hasUnread
          ? "Scroll to latest messages, new replies below"
          : "Scroll to latest messages"
      }
      accessibilityRole="button"
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.scrollToBottomFab,
        bottomOffset !== undefined && { bottom: bottomOffset },
        pressed && styles.scrollToBottomFabPressed,
      ]}
    >
      <Icon
        name="chevron-down"
        size={20}
        color={colors.accent}
        weight="semibold"
      />
      {hasUnread ? <View style={styles.scrollToBottomDot} /> : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// "+" menu — single source of truth for composer attach actions across both
// the chat and the computer chat. The chat has both Attach + View computer;
// the computer chat skips Attach since it doesn't accept image input.
//
// The menu renders as a small popover anchored just above the `+` button
// (drop-up, since the composer is at the bottom of the screen) rather than
// a center-screen action sheet. This mirrors the desktop's `+` menu
// behavior and feels more native for an inline composer affordance.
// ---------------------------------------------------------------------------

type PlusMenuOption = {
  id: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
  disabled?: boolean;
  selected?: boolean;
  trailingLabel?: string;
  /** When set, tapping opens this list instead of calling `onSelect`. */
  submenu?: PlusMenuOption[];
  /** Header shown above a submenu (defaults to the parent row label). */
  submenuTitle?: string;
};

type PlusMenuLevel = {
  title: string;
  options: PlusMenuOption[];
};

type AnchorRect = { x: number; y: number; width: number; height: number };

export type ChatPaneModelOption = {
  id: string;
  name: string;
  allowedForAudience: boolean;
};

const PLUS_MENU_GAP = 10;
const PLUS_MENU_MIN_WIDTH = 200;
const PLUS_MENU_EDGE_PADDING = 12;

function PlusMenuPopover({
  visible,
  anchor,
  options,
  onDismiss,
  colors,
}: {
  visible: boolean;
  anchor: AnchorRect | null;
  options: PlusMenuOption[];
  onDismiss: () => void;
  colors: Colors;
}) {
  const styles = useMemo(() => makePlusMenuStyles(colors), [colors]);
  const [menuLayout, setMenuLayout] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [submenuStack, setSubmenuStack] = useState<PlusMenuLevel[]>([]);

  useEffect(() => {
    if (!visible) {
      setMenuLayout(null);
      setSubmenuStack([]);
    }
  }, [visible]);

  const activeLevel = submenuStack[submenuStack.length - 1];
  const visibleOptions = activeLevel?.options ?? options;
  const submenuTitle = activeLevel?.title ?? null;

  const handleRequestClose = useCallback(() => {
    if (submenuStack.length > 0) {
      setSubmenuStack((prev) => prev.slice(0, -1));
      setMenuLayout(null);
      return;
    }
    onDismiss();
  }, [onDismiss, submenuStack.length]);

  const goBack = useCallback(() => {
    setSubmenuStack((prev) => prev.slice(0, -1));
    setMenuLayout(null);
  }, []);

  const onSelectOption = useCallback(
    (option: PlusMenuOption) => {
      const submenu = option.submenu;
      if (submenu && submenu.length > 0) {
        setSubmenuStack((prev) => [
          ...prev,
          {
            title: option.submenuTitle ?? option.label,
            options: submenu,
          },
        ]);
        setMenuLayout(null);
        return;
      }
      setSubmenuStack([]);
      onDismiss();
      option.onSelect();
    },
    [onDismiss],
  );

  if (!visible || !anchor) {
    return null;
  }

  const screen = Dimensions.get("window");
  const measured = menuLayout;
  const desiredWidth = Math.max(PLUS_MENU_MIN_WIDTH, measured?.width ?? 0);
  // Left-align with the anchor, clamped inside the screen so the bubble
  // never spills past the edge of the device.
  const left = Math.min(
    Math.max(PLUS_MENU_EDGE_PADDING, anchor.x),
    screen.width - desiredWidth - PLUS_MENU_EDGE_PADDING,
  );
  // Drop-up by default; fall back to drop-down if the menu wouldn't fit
  // above the anchor.
  const menuHeight = measured?.height ?? 0;
  const dropUpTop = anchor.y - menuHeight - PLUS_MENU_GAP;
  const top =
    measured && dropUpTop < PLUS_MENU_EDGE_PADDING
      ? anchor.y + anchor.height + PLUS_MENU_GAP
      : dropUpTop;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={handleRequestClose}
      statusBarTranslucent
    >
      <Pressable
        style={styles.backdrop}
        onPress={handleRequestClose}
        accessibilityLabel="Dismiss menu"
      >
        <View
          // Stop the backdrop's onPress from firing when the user taps
          // inside the menu itself.
          onStartShouldSetResponder={() => true}
          onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            setMenuLayout({ width, height });
          }}
          style={[
            styles.menu,
            {
              left,
              minWidth: PLUS_MENU_MIN_WIDTH,
              opacity: measured ? 1 : 0,
              top: measured ? top : anchor.y - PLUS_MENU_GAP,
            },
          ]}
        >
          {submenuTitle ? (
            <Pressable
              accessibilityLabel="Back to menu"
              onPress={goBack}
              style={({ pressed }) => [
                styles.menuItem,
                styles.menuItemFirst,
                styles.submenuHeader,
                pressed && styles.menuItemPressed,
              ]}
            >
              <Icon
                name="chevron-left"
                size={16}
                color={colors.textMuted}
                style={styles.menuItemIcon}
              />
              <Text style={styles.submenuHeaderLabel} numberOfLines={1}>
                {submenuTitle}
              </Text>
            </Pressable>
          ) : null}
          {visibleOptions.map((option, index) => {
            const isFirst = !submenuTitle && index === 0;
            const isLast = index === visibleOptions.length - 1;
            const hasSubmenu = Boolean(option.submenu?.length);
            return (
              <Pressable
                key={option.id}
                accessibilityLabel={option.label}
                disabled={option.disabled}
                onPress={() => onSelectOption(option)}
                style={({ pressed }) => [
                  styles.menuItem,
                  isFirst && styles.menuItemFirst,
                  isLast && styles.menuItemLast,
                  pressed && styles.menuItemPressed,
                  option.disabled && styles.menuItemDisabled,
                ]}
              >
                <Icon
                  name={option.icon}
                  size={16}
                  color={option.disabled ? colors.textMuted : colors.text}
                  style={styles.menuItemIcon}
                />
                <Text
                  style={[
                    styles.menuItemLabel,
                    option.disabled && styles.menuItemLabelMuted,
                  ]}
                  numberOfLines={1}
                >
                  {option.label}
                </Text>
                {option.trailingLabel ? (
                  <Text style={styles.menuItemTrailing} numberOfLines={1}>
                    {option.trailingLabel}
                  </Text>
                ) : hasSubmenu ? (
                  <Icon
                    name="chevron-right"
                    size={15}
                    color={colors.textMuted}
                    style={styles.menuItemCheck}
                  />
                ) : option.selected ? (
                  <Icon
                    name="check"
                    size={15}
                    color={colors.accent}
                    style={styles.menuItemCheck}
                  />
                ) : null}
              </Pressable>
            );
          })}
        </View>
      </Pressable>
    </Modal>
  );
}

const makePlusMenuStyles = (colors: Colors) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      // No visible scrim — the menu is a lightweight popover, not a
      // modal dialog. The Pressable still catches outside taps.
      backgroundColor: "transparent",
    },
    menu: {
      backgroundColor: colors.surface,
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      paddingVertical: 6,
      position: "absolute",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.18,
      shadowRadius: 24,
      elevation: 12,
    },
    menuItem: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    menuItemFirst: {},
    menuItemLast: {},
    menuItemPressed: { backgroundColor: fadeHex(colors.text, 0.06) },
    menuItemDisabled: { opacity: 0.55 },
    menuItemIcon: { width: 20 },
    menuItemLabel: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    menuItemLabelMuted: { color: colors.textMuted },
    menuItemTrailing: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.15,
      marginLeft: 12,
      maxWidth: 136,
    },
    menuItemCheck: { marginLeft: 12 },
    submenuHeader: {
      borderBottomColor: fadeHex(colors.border, 0.55),
      borderBottomWidth: StyleSheet.hairlineWidth,
      marginBottom: 4,
      paddingBottom: 10,
    },
    submenuHeaderLabel: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.15,
    },
  });

// ---------------------------------------------------------------------------
// ChatPane — full chat screen surface (list + composer + scroll model).
// Used by both the chat and the computer chat so both render visually
// identically; the parent just owns message state and submission.
// ---------------------------------------------------------------------------

export type ChatPaneProps = {
  /** Visible message list (parent-owned). */
  messages: ChatMessage[];
  /** True while a reply is streaming — controls composer stop button. */
  streaming: boolean;
  /** Empty-state body. Rendered centered when there are no messages. */
  emptyContent: ReactNode;

  /** Composer input value. */
  draft: string;
  /** Composer input change handler. */
  onChangeDraft: (next: string) => void;
  /** Whether the composer accepts text (typing + sending). */
  composerEnabled?: boolean;
  /** Visible placeholder when not transcribing. */
  placeholder: string;

  /** Computed once per parent re-render; controls submit button enabled. */
  canSubmit: boolean;
  /** Triggered by the send button or `return` key. */
  onSubmit: () => void;
  /**
   * Optional stop handler. When provided AND `streaming` is true, the send
   * button is replaced by a stop button that calls this. Used to cancel the
   * in-flight reply (and any queued follow-ups) for both the local chat
   * stream and the computer-chat round trip.
   */
  onStop?: () => void;

  /** Show a small `+` menu entry for attaching photos. */
  enableAttachments: boolean;
  /** Current attachments — only meaningful when `enableAttachments`. */
  attachments?: ImagePicker.ImagePickerAsset[];
  /** Replace the attachment list (e.g. add picked or remove one). */
  onChangeAttachments?: (next: ImagePicker.ImagePickerAsset[]) => void;

  /**
   * Optional `View computer` action to surface from the `+` menu.
   * When provided, renders the menu entry in both the pill and expanded forms.
   */
  onViewComputer?: () => void;

  selectedModel?: string;
  selectedModelLabel?: string;
  modelOptions?: ChatPaneModelOption[];
  onSelectModel?: (modelId: string) => void;

  /** Headers passed to the dictation upload (e.g. mobile device id for guests). */
  dictationAnonymous: boolean;
  dictationHeaders?: Record<string, string>;
};

export function ChatPane({
  messages,
  streaming,
  emptyContent,
  draft,
  onChangeDraft,
  composerEnabled = true,
  placeholder,
  canSubmit,
  onSubmit,
  onStop,
  enableAttachments,
  attachments,
  onChangeAttachments,
  onViewComputer,
  selectedModel,
  selectedModelLabel,
  modelOptions,
  onSelectModel,
  dictationAnonymous,
  dictationHeaders,
}: ChatPaneProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const readAloud = useReadAloudPreference();

  const inputRef = useRef<TextInput>(null);
  const { height: keyboardHeight, composerBottomPad } = useKeyboardInset();
  // The composer + working indicator overlay the bottom of the chat. We
  // measure their actual height so the FlashList can reserve matching
  // bottom inset, letting messages scroll under the composer (visible
  // through transparent margins around the GlassView) instead of being
  // clipped by it.
  const [footerHeight, setFooterHeight] = useState(0);
  const listTrailingSlackPx = EDGE_FADE + footerHeight;

  const assistantTextLenRef = useRef(0);
  const assistantIdRef = useRef<string | null>(null);
  const scroll = useChatScroll(listTrailingSlackPx);

  const [unread, setUnread] = useState(false);
  const prevLenRef = useRef(0);
  const wasStreamingRef = useRef(false);
  const spokenAssistantIdsRef = useRef<Set<string>>(new Set());

  const lastMessage = messages[messages.length - 1];
  if (lastMessage?.role === "assistant") {
    const isNewAssistant = lastMessage.id !== assistantIdRef.current;
    const grewText =
      lastMessage.text.length > assistantTextLenRef.current;
    if (isNewAssistant) {
      scroll.resetAssistantAutoScroll();
    }
    if (isNewAssistant || grewText) {
      scroll.prepareAssistantLayoutFollow();
    }
    assistantTextLenRef.current = lastMessage.text.length;
    assistantIdRef.current = lastMessage.id;
  } else {
    assistantTextLenRef.current = 0;
    assistantIdRef.current = null;
  }

  useEffect(() => {
    if (streaming) scroll.resetAssistantAutoScroll();
  }, [streaming, scroll.resetAssistantAutoScroll]);

  // Anchor at the bottom on first load so we open into the latest message
  // instead of the top of the history. Wait two frames so FlashList has
  // laid out and the content size is real before jumping.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (messages.length === 0) return;
    didInitialScrollRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scroll.listRef.current?.scrollToEnd({ animated: false });
      });
    });
  }, [messages.length, scroll.listRef]);

  // When the keyboard rises while the user is at/near the bottom, pull the
  // chat up so the keyboard doesn't cover the latest messages. If the user
  // is reading further up, leave their scroll position alone.
  const prevKeyboardHeightRef = useRef(0);
  useEffect(() => {
    const prev = prevKeyboardHeightRef.current;
    prevKeyboardHeightRef.current = keyboardHeight;
    if (keyboardHeight > prev && !scroll.awayFromBottom) {
      requestAnimationFrame(() =>
        scroll.listRef.current?.scrollToEnd({ animated: true }),
      );
    }
  }, [keyboardHeight, scroll.awayFromBottom, scroll.listRef]);

  useEffect(() => {
    const grew = messages.length > prevLenRef.current;
    prevLenRef.current = messages.length;
    if (messages.length === 0) {
      setUnread(false);
      return;
    }
    if (grew && scroll.awayFromBottom) setUnread(true);
  }, [messages.length, scroll.awayFromBottom]);

  useEffect(() => {
    if (!scroll.awayFromBottom) setUnread(false);
  }, [scroll.awayFromBottom]);

  useEffect(() => {
    if (!readAloud.enabled) return;
    if (streaming) {
      wasStreamingRef.current = true;
      return;
    }
    if (!wasStreamingRef.current) return;
    wasStreamingRef.current = false;
    const latestAssistant = [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.text.trim());
    if (!latestAssistant || spokenAssistantIdsRef.current.has(latestAssistant.id)) {
      return;
    }
    spokenAssistantIdsRef.current.add(latestAssistant.id);
    void speakReply(latestAssistant.text);
  }, [messages, readAloud.enabled, streaming]);

  const [expanded, setExpanded] = useState(false);
  const hasMountedRef = useRef(false);
  const wasFocusedRef = useRef(false);

  // When the parent clears draft after send, collapse back to pill shape.
  useEffect(() => {
    if (expanded && draft.length === 0) {
      LayoutAnimation.configureNext(LAYOUT_SPRING);
      setExpanded(false);
    }
  }, [draft, expanded]);

  // The pill and expanded shapes render separate `TextInput` instances, so
  // swapping between them drops focus and silently swallows the keystrokes
  // that triggered the expansion. Re-focus the freshly-mounted input on the
  // next frame so typing keeps flowing into it without a visible blur.
  useEffect(() => {
    if (!wasFocusedRef.current) return;
    const handle = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(handle);
  }, [expanded]);

  // Expansion is one-way while the user is typing: the pill and expanded
  // shapes give the text different widths, so a 2-line pill can re-flow to
  // 1 line in expanded shape — flipping back to pill would re-wrap and
  // oscillate forever. Collapse happens only when the parent clears the
  // draft (see the `useEffect` above) or via dedicated dictation handlers.
  const handleContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      if (!hasMountedRef.current) {
        hasMountedRef.current = true;
        return;
      }
      if (expanded) return;
      const h = e.nativeEvent.contentSize.height;
      if (h > EXPAND_THRESHOLD) {
        LayoutAnimation.configureNext(LAYOUT_SPRING);
        setExpanded(true);
      }
    },
    [expanded],
  );

  const submit = useCallback(() => {
    tapMedium();
    onSubmit();
    scroll.nudgeAfterSend();
  }, [onSubmit, scroll.nudgeAfterSend]);

  const dictationHeadersMemo = useMemo(
    () => dictationHeaders,
    // We trust the parent to memoize these.
    [dictationHeaders],
  );

  // Use a ref so the dictation transcript callback always sees the latest
  // draft, even when a transcription chunk lands after the parent re-renders.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const appendTranscript = useCallback(
    (text: string) => {
      const trimmedPrev = draftRef.current.trimEnd();
      const next = trimmedPrev ? `${trimmedPrev} ${text}` : text;
      onChangeDraft(next);
    },
    [onChangeDraft],
  );

  const dictation = useDictation({
    anonymous: dictationAnonymous,
    headers: dictationHeadersMemo,
    onTranscript: appendTranscript,
  });

  const isListening = dictation.isRecording;

  const toggleVoice = useCallback(async () => {
    if (dictation.status === "idle") tapLight();
    await dictation.toggle();
  }, [dictation]);

  const pickImage = useCallback(async () => {
    if (!enableAttachments || !onChangeAttachments) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        "Photos",
        "Allow Stella to access your photo library in Settings so you can attach images.",
        [{ text: "OK" }],
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 0.75,
      selectionLimit: 5,
      base64: true,
    });
    if (!result.canceled && result.assets.length > 0) {
      const current = attachments ?? [];
      onChangeAttachments([...current, ...result.assets]);
    }
  }, [attachments, enableAttachments, onChangeAttachments]);

  const removeAttachment = useCallback(
    (uri: string) => {
      if (!onChangeAttachments) return;
      onChangeAttachments((attachments ?? []).filter((a) => a.uri !== uri));
    },
    [attachments, onChangeAttachments],
  );

  const plusAnchorRef = useRef<View>(null);
  const [plusMenuAnchor, setPlusMenuAnchor] = useState<AnchorRect | null>(null);

  const plusMenuOptions = useMemo<PlusMenuOption[]>(() => {
    const out: PlusMenuOption[] = [];
    if (enableAttachments) {
      out.push({
        id: "attach-photo",
        label: "Attach a photo",
        icon: "image",
        onSelect: () => void pickImage(),
      });
    }
    if (onViewComputer) {
      out.push({
        id: "view-computer",
        label: "View computer",
        icon: "monitor",
        onSelect: onViewComputer,
      });
    }
    if (onSelectModel && selectedModelLabel && (modelOptions?.length ?? 0) > 0) {
      out.push({
        id: "model-picker",
        label: selectedModelLabel,
        icon: "cpu",
        submenuTitle: "Model",
        submenu: (modelOptions ?? []).map((model) => ({
          id: `model-${model.id}`,
          label: model.name,
          icon: "cpu",
          selected: selectedModel === model.id,
          disabled: !model.allowedForAudience,
          onSelect: () => {
            if (model.allowedForAudience) onSelectModel(model.id);
          },
        })),
        onSelect: () => {},
      });
    }
    out.push({
      id: "read-aloud",
      label: readAloud.enabled ? "Stop reading aloud" : "Read replies aloud",
      icon: readAloud.enabled ? "volume-2" : "volume-x",
      onSelect: () => void readAloud.setEnabled(!readAloud.enabled),
    });
    return out;
  }, [
    enableAttachments,
    modelOptions,
    onSelectModel,
    onViewComputer,
    pickImage,
    readAloud,
    selectedModel,
    selectedModelLabel,
  ]);

  const onPressPlus = useCallback(() => {
    if (plusMenuOptions.length === 0) return;
    if (
      plusMenuOptions.length === 1 &&
      plusMenuOptions[0].id === "attach-photo"
    ) {
      // Single-action: fall straight through so the menu doesn't add friction.
      void pickImage();
      return;
    }
    const anchor = plusAnchorRef.current;
    if (!anchor) return;
    Keyboard.dismiss();
    anchor.measureInWindow((x, y, width, height) => {
      setPlusMenuAnchor({ x, y, width, height });
    });
  }, [pickImage, plusMenuOptions]);

  const dismissPlusMenu = useCallback(() => setPlusMenuAnchor(null), []);

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);
  // Stream fade is driven per-row: only the trailing assistant message
  // animates while `streaming` is true. AssistantMarkdown itself latches
  // this flag for the row's lifetime, so the per-phrase fade keeps running
  // through the brief render where `streaming` flips false at end-of-turn.
  const streamingAssistantId =
    streaming && lastMessage?.role === "assistant" ? lastMessage.id : null;
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatMessage>) => (
      <FadeInMessage key={item.id}>
        <ChatMessageRow
          item={item}
          styles={styles}
          colors={colors}
          isStreaming={item.id === streamingAssistantId}
        />
      </FadeInMessage>
    ),
    [styles, colors, streamingAssistantId],
  );
  const renderSeparator = useCallback(
    () => <View style={styles.itemSeparator} />,
    [styles],
  );
  const getItemType = useCallback((item: ChatMessage) => item.role, []);

  const empty = messages.length === 0;
  const hasText = draft.trim().length > 0;
  const dictationInline = isListening && !hasText;
  const dictationBelow = isListening && hasText;
  const isExpandedComposed = expanded || dictationBelow;

  const hasPlusMenu = composerEnabled;

  const plusButton = hasPlusMenu ? (
    <View ref={plusAnchorRef} collapsable={false}>
      <Pressable
        style={styles.addButton}
        hitSlop={4}
        accessibilityLabel="Open add menu"
        onPress={onPressPlus}
      >
        <Icon
          name="plus"
          size={17}
          color={colors.textMuted}
          weight="semibold"
        />
      </Pressable>
    </View>
  ) : null;

  const showAttachmentStrip =
    enableAttachments && (attachments?.length ?? 0) > 0;

  const listContentContainerStyle = useMemo(
    () => [styles.list, { paddingBottom: EDGE_FADE + footerHeight }],
    [styles.list, footerHeight],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.viewport}>
        {empty ? (
          <Pressable style={styles.emptyState} onPress={() => Keyboard.dismiss()}>
            {emptyContent}
          </Pressable>
        ) : (
          <>
            <FlashList
              ref={scroll.listRef}
              style={styles.messageList}
              contentContainerStyle={listContentContainerStyle}
              data={messages}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              getItemType={getItemType}
              ItemSeparatorComponent={renderSeparator}
              onScroll={scroll.onScroll}
              onContentSizeChange={scroll.onListContentSizeChange}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              keyboardDismissMode="on-drag"
              fadingEdgeLength={EDGE_FADE}
              initialScrollIndex={
                didInitialScrollRef.current
                  ? undefined
                  : Math.max(0, messages.length - 1)
              }
            />
            <ScrollToBottomFab
              visible={scroll.awayFromBottom}
              hasUnread={unread}
              onPress={scroll.scrollToBottom}
              styles={styles}
              colors={colors}
              bottomOffset={footerHeight + 8}
            />
          </>
        )}
      </View>

      <View
        style={[styles.footerOverlay, { paddingBottom: keyboardHeight }]}
        onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
        pointerEvents="box-none"
      >
        <WorkingIndicator active={streaming} />
        <View style={[styles.composerWrap, { paddingBottom: composerBottomPad }]}>
        {showAttachmentStrip && (
          <View style={styles.attachmentStrip}>
            {(attachments ?? []).map((asset) => (
              <View key={asset.uri} style={styles.attachmentThumb}>
                <Image
                  source={{ uri: asset.uri }}
                  style={styles.attachmentImage}
                  contentFit="cover"
                />
                <Pressable
                  style={styles.attachmentRemove}
                  accessibilityLabel="Remove attached photo"
                  onPress={() => removeAttachment(asset.uri)}
                  hitSlop={4}
                >
                  <Icon
                    name="x"
                    size={12}
                    color={colors.accentForeground}
                    weight="bold"
                  />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        <GlassView
          style={[
            styles.shell,
            isExpandedComposed ? styles.shellExpanded : styles.shellPill,
          ]}
        >
          {dictationInline ? (
            <View style={styles.formPill}>
              {plusButton}
              <DictationRecordingBar
                levels={dictation.levels}
                elapsedMs={dictation.elapsedMs}
                onCancel={() => void dictation.cancel()}
                onConfirm={() => void dictation.stop()}
              />
            </View>
          ) : isExpandedComposed ? (
            <View style={styles.formExpanded}>
              <TextInput
                ref={inputRef}
                multiline
                onChangeText={onChangeDraft}
                onContentSizeChange={handleContentSizeChange}
                onFocus={() => { wasFocusedRef.current = true; }}
                onBlur={() => { wasFocusedRef.current = false; }}
                blurOnSubmit={false}
                placeholder={placeholder}
                placeholderTextColor={fadeHex(colors.textMuted, 0.35)}
                selectionColor={colors.accent}
                underlineColorAndroid="transparent"
                style={styles.inputExpanded}
                value={draft}
                editable={composerEnabled}
              />
              <View style={styles.toolbar}>
                <View style={styles.toolbarLeft}>{plusButton}</View>
                <View style={styles.toolbarRight}>
                  <Pressable
                    onPress={() => void toggleVoice()}
                    accessibilityLabel={
                      isListening ? "Stop voice input" : "Start voice input"
                    }
                    disabled={dictation.isTranscribing}
                    style={[
                      styles.micButton,
                      isListening && styles.micButtonActive,
                    ]}
                    hitSlop={4}
                  >
                    <Icon
                      name={isListening ? "mic-off" : "mic"}
                      size={20}
                      color={
                        isListening ? colors.accentForeground : colors.textMuted
                      }
                      filled={isListening}
                    />
                  </Pressable>
                  {streaming && onStop && !hasText ? (
                    <StopButton
                      onPress={onStop}
                      styles={styles}
                      colors={colors}
                    />
                  ) : (
                    <AnimatedSubmitButton
                      canSubmit={canSubmit}
                      onPress={submit}
                      styles={styles}
                      colors={colors}
                      accessibilityLabel={
                        streaming ? "Queue follow-up message" : "Send message"
                      }
                    />
                  )}
                </View>
              </View>
              {dictationBelow && (
                <View style={styles.dictationRow}>
                  <DictationRecordingBar
                    levels={dictation.levels}
                    elapsedMs={dictation.elapsedMs}
                    onCancel={() => void dictation.cancel()}
                    onConfirm={() => void dictation.stop()}
                  />
                </View>
              )}
            </View>
          ) : (
            <View style={styles.formPill}>
              {plusButton}
              <TextInput
                ref={inputRef}
                multiline
                scrollEnabled={false}
                onChangeText={onChangeDraft}
                onContentSizeChange={handleContentSizeChange}
                onFocus={() => { wasFocusedRef.current = true; }}
                onBlur={() => { wasFocusedRef.current = false; }}
                placeholder={
                  dictation.isTranscribing ? "Transcribing\u2026" : placeholder
                }
                placeholderTextColor={fadeHex(colors.textMuted, 0.35)}
                selectionColor={colors.accent}
                underlineColorAndroid="transparent"
                style={styles.inputPill}
                value={draft}
                editable={composerEnabled}
              />
              {streaming && onStop && !hasText ? (
                <StopButton
                  onPress={onStop}
                  styles={styles}
                  colors={colors}
                />
              ) : canSubmit ? (
                <AnimatedSubmitButton
                  canSubmit={canSubmit}
                  onPress={submit}
                  styles={styles}
                  colors={colors}
                  accessibilityLabel={
                    streaming ? "Queue follow-up message" : "Send message"
                  }
                />
              ) : (
                <Pressable
                  onPress={() => void toggleVoice()}
                  accessibilityLabel={
                    isListening ? "Stop voice input" : "Start voice input"
                  }
                  disabled={dictation.isTranscribing}
                  style={[
                    styles.micButton,
                    isListening && styles.micButtonActive,
                  ]}
                  hitSlop={4}
                >
                  <Icon
                    name={isListening ? "mic-off" : "mic"}
                    size={20}
                    color={
                      isListening ? colors.accentForeground : colors.textMuted
                    }
                    filled={isListening}
                  />
                </Pressable>
              )}
            </View>
          )}
        </GlassView>
        </View>
      </View>
      <PlusMenuPopover
        visible={Boolean(plusMenuAnchor) && plusMenuOptions.length > 0}
        anchor={plusMenuAnchor}
        options={plusMenuOptions}
        onDismiss={dismissPlusMenu}
        colors={colors}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      marginHorizontal: -SHELL_CONTENT_PADDING,
      position: "relative",
    },

    // Anchored at the bottom of the screen, above the message list. The list
    // gets matching bottom inset (via `footerHeight`) so content can still be
    // scrolled fully into view; the transparent gutters around the composer
    // shell let messages peek through as they pass underneath.
    footerOverlay: {
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
    },

    viewport: { flex: 1, minHeight: 0, position: "relative" },
    messageList: { flex: 1 },
    scrollToBottomFab: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderColor: colors.borderStrong,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      bottom: 8,
      height: 44,
      justifyContent: "center",
      position: "absolute",
      right: CHAT_HORIZONTAL_INSET,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 10,
      elevation: 4,
      width: 44,
    },
    scrollToBottomFabPressed: { opacity: 0.88 },
    scrollToBottomDot: {
      backgroundColor: colors.accent,
      borderColor: colors.surface,
      borderRadius: 5,
      borderWidth: 1.5,
      height: 10,
      position: "absolute",
      right: 6,
      top: 6,
      width: 10,
    },
    list: {
      paddingHorizontal: CHAT_HORIZONTAL_INSET,
      paddingTop: 80,
      paddingBottom: EDGE_FADE,
    },
    itemSeparator: { height: MESSAGE_LIST_GAP },

    emptyState: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },

    userRow: { flexDirection: "row", justifyContent: "flex-end" },
    userColumn: { alignItems: "flex-end", maxWidth: "92%" },
    userBubble: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.borderStrong,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 18,
      borderBottomRightRadius: 4,
      padding: 12,
    },
    userBubbleQueued: { opacity: 0.55 },
    queuedTag: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 11,
      letterSpacing: 0.4,
      marginTop: 4,
      marginRight: 4,
      textTransform: "uppercase",
    },
    stoppedTag: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 11,
      letterSpacing: 0.4,
      marginTop: 6,
      textTransform: "uppercase",
    },
    userText: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      letterSpacing: 0.03 * 17,
      lineHeight: 17 * 1.52,
    },
    userThumbStrip: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    userThumbsAbove: { marginBottom: 8 },
    userThumbImage: {
      backgroundColor: colors.muted,
      borderRadius: 8,
      height: 84,
      width: 84,
    },

    assistantRow: { paddingVertical: 4 },
    assistantText: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      fontWeight: "400",
      letterSpacing: 0.03 * 17,
      lineHeight: 17 * 1.52,
    },

    composerWrap: {
      alignItems: "center",
      flexShrink: 0,
      gap: 8,
      paddingBottom: 6,
      paddingHorizontal: CHAT_HORIZONTAL_INSET,
      paddingTop: 12,
    },

    attachmentStrip: {
      flexDirection: "row",
      gap: 8,
      paddingBottom: 10,
      paddingHorizontal: 4,
    },
    attachmentThumb: {
      borderRadius: 10,
      height: 64,
      overflow: "hidden",
      position: "relative",
      width: 64,
    },
    attachmentImage: { borderRadius: 10, height: 64, width: 64 },
    attachmentRemove: {
      alignItems: "center",
      backgroundColor: "rgba(0,0,0,0.55)",
      borderRadius: 10,
      height: 20,
      justifyContent: "center",
      position: "absolute",
      right: 3,
      top: 3,
      width: 20,
    },

    shell: {
      borderColor: fadeHex(colors.border, 0.6),
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
      width: "100%",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.08,
      shadowRadius: 24,
      elevation: 8,
    },
    shellPill: { borderRadius: 999 },
    shellExpanded: { borderRadius: 20 },

    formPill: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      minHeight: 50,
      paddingHorizontal: 8,
      paddingVertical: 8,
    },
    formExpanded: { flexDirection: "column" },

    inputPill: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      letterSpacing: -0.2,
      lineHeight: 22,
      maxHeight: 32,
      paddingHorizontal: 4,
      paddingVertical: 0,
      ...(Platform.OS === "android"
        ? { textAlignVertical: "center" as const }
        : {}),
    },
    inputExpanded: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      letterSpacing: -0.2,
      lineHeight: 24,
      maxHeight: 200,
      minHeight: 40,
      paddingHorizontal: 16,
      paddingTop: 11,
      paddingBottom: 2,
    },

    toolbar: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingBottom: 6,
      paddingHorizontal: 8,
      paddingTop: 2,
    },
    toolbarLeft: { flexDirection: "row", alignItems: "center", gap: 4 },
    toolbarRight: { flexDirection: "row", alignItems: "center", gap: 8 },

    dictationRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
      paddingBottom: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: fadeHex(colors.border, 0.5),
    },

    addButton: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.text, 0.06),
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    submitButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    micButton: {
      alignItems: "center",
      backgroundColor: "transparent",
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    micButtonActive: { backgroundColor: colors.accent },
  } as const);
