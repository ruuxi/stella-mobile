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
 * Desktop uses scrollHeight > 44 which includes padding.
 * RN onContentSizeChange reports raw text height (no padding).
 * fontSize 16 × lineHeight ~22 ≈ 22 per line → two lines ≈ 44.
 * Use a value just above two lines so single-line typing stays pill.
 */
const EXPAND_THRESHOLD = 48;
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

/** Pixels from the bottom of the content past which we show "scroll to bottom". */
const SCROLL_AWAY_FROM_BOTTOM_THRESHOLD = 96;

/** Small acknowledgement scroll on send, matching desktop's ~48px nudge. */
const SEND_NUDGE_PX = 48;

/** Breathing room below the streaming row while auto-following (desktop parity). */
const FOLLOW_BREATHING_PX = 72;

/** Peek of the prior message when the stream row pins to the top. */
const FOLLOW_TOP_PEEK_PX = 56;

/** Adaptive lerp toward the follow target (mirrors desktop scroll management). */
const FOLLOW_LERP_FACTOR_BASE = 0.3;
const FOLLOW_LERP_FACTOR_MAX = 0.65;
const FOLLOW_LERP_FACTOR_SCALE = 0.005;
const FOLLOW_HARD_SNAP_PX = 240;
const FOLLOW_MIN_STEP_PX = 0.5;

/**
 * Tail spacer below the conversation while a turn is in progress, so a freshly
 * sent user message can land near the top and the streaming assistant message
 * has room to grow into empty space (mirrors desktop's `.session-turn--last-turn`
 * reading-area min-height).
 */
const TAIL_SPACER_PX = 180;

const EDGE_FADE = 48;
const MESSAGE_LIST_GAP = 20;

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
// Scroll model — mirrors desktop chat scroll behavior.
// ---------------------------------------------------------------------------

function useChatScroll(opts: { messages: ChatMessage[]; streaming: boolean }) {
  const { messages, streaming } = opts;
  const listRef = useRef<FlashListRef<ChatMessage>>(null);
  const offsetYRef = useRef(0);
  const layoutHRef = useRef(0);
  const contentHRef = useRef(0);
  const pinnedRef = useRef(true);
  const draggingRef = useRef(false);
  const lockedRef = useRef(false);
  /** Live height of the streaming assistant row (FlashList layout lags text growth). */
  const streamingRowHeightRef = useRef(0);
  const followTargetRef = useRef<number | null>(null);
  const followRafRef = useRef<number | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  const streamingIndex = streaming ? messages.length - 1 : -1;
  const streamingMessageId =
    streamingIndex >= 0 ? messages[streamingIndex]?.id : null;
  const streamingTextLen =
    streamingIndex >= 0 ? messages[streamingIndex]?.text.length ?? 0 : 0;

  const lastUserIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  }, [messages]);

  useEffect(() => {
    if (streaming) {
      lockedRef.current = false;
    } else {
      streamingRowHeightRef.current = 0;
    }
  }, [streaming, lastUserIndex]);

  const readScrollOffset = useCallback((list: FlashListRef<ChatMessage>) => {
    if (typeof list.getAbsoluteLastScrollOffset === "function") {
      return list.getAbsoluteLastScrollOffset();
    }
    return offsetYRef.current;
  }, []);

  const readContentHeight = useCallback((list: FlashListRef<ChatMessage>) => {
    const dims = list.getChildContainerDimensions?.();
    if (dims && dims.height > 0) return dims.height;
    return contentHRef.current;
  }, []);

  const readMaxScrollOffset = useCallback(
    (list: FlashListRef<ChatMessage>, viewportH: number, contentH: number) =>
      Math.max(0, contentH - viewportH),
    [],
  );

  const stopFollowLoop = useCallback(() => {
    if (followRafRef.current !== null) {
      cancelAnimationFrame(followRafRef.current);
      followRafRef.current = null;
    }
    followTargetRef.current = null;
  }, []);

  const scrollListToOffset = useCallback(
    (list: FlashListRef<ChatMessage>, offset: number) => {
      const clamped = Math.max(0, offset);
      list.scrollToOffset({
        offset: clamped,
        animated: false,
        skipFirstItemOffset: false,
      });
      offsetYRef.current = clamped;
    },
    [],
  );

  /**
   * Resolve the scroll offset we want while streaming. `null` means idle;
   * during layout warmup we target the list bottom instead of a row anchor.
   */
  const computeStreamingFollowTarget = useCallback((): number | null => {
    if (draggingRef.current || !pinnedRef.current || lockedRef.current) {
      return null;
    }

    const list = listRef.current;
    if (!list || streamingIndex < 0) return null;

    const viewportH = layoutHRef.current || list.getWindowSize().height || 0;
    if (viewportH <= 0) return null;

    const contentH = readContentHeight(list);
    if (contentH <= 0) return null;
    contentHRef.current = contentH;

    const currentOffset = readScrollOffset(list);
    const layout = list.getLayout(streamingIndex);
    const measuredHeight = streamingRowHeightRef.current;
    const rowHeight = Math.max(measuredHeight, layout?.height ?? 0);

    if (!layout || rowHeight <= 0) {
      return readMaxScrollOffset(list, viewportH, contentH);
    }

    const rowTop = layout.y;
    const rowBottom = rowTop + rowHeight;

    if (rowTop <= currentOffset + 2) {
      lockedRef.current = true;
      return null;
    }

    const desiredOffset = rowBottom - viewportH + FOLLOW_BREATHING_PX;
    const pinnedTop = Math.max(0, rowTop - FOLLOW_TOP_PEEK_PX);
    return Math.min(pinnedTop, desiredOffset);
  }, [
    readContentHeight,
    readMaxScrollOffset,
    readScrollOffset,
    streamingIndex,
  ]);

  const stepFollowLoop = useCallback(() => {
    followRafRef.current = null;

    if (draggingRef.current || !pinnedRef.current || lockedRef.current) {
      followTargetRef.current = null;
      return;
    }

    if (streaming) {
      const freshTarget = computeStreamingFollowTarget();
      if (freshTarget === null) {
        followTargetRef.current = null;
        return;
      }
      followTargetRef.current = freshTarget;
    }

    const target = followTargetRef.current;
    if (target === null) return;

    const list = listRef.current;
    if (!list) return;

    const viewportH = layoutHRef.current || list.getWindowSize().height || 0;
    if (viewportH <= 0) return;

    const contentH = readContentHeight(list);
    if (contentH <= 0) return;

    const maxScroll = readMaxScrollOffset(list, viewportH, contentH);
    const clampedTarget = Math.max(0, Math.min(maxScroll, target));
    const current = readScrollOffset(list);
    const diff = clampedTarget - current;
    const absDiff = Math.abs(diff);

    if (absDiff < FOLLOW_MIN_STEP_PX) {
      scrollListToOffset(list, clampedTarget);
      if (!streaming) {
        followTargetRef.current = null;
        return;
      }
    } else if (absDiff > FOLLOW_HARD_SNAP_PX) {
      scrollListToOffset(list, clampedTarget);
    } else {
      const factor = Math.min(
        FOLLOW_LERP_FACTOR_MAX,
        FOLLOW_LERP_FACTOR_BASE + absDiff * FOLLOW_LERP_FACTOR_SCALE,
      );
      const lerpStep = diff * factor;
      const stepPx =
        Math.abs(lerpStep) >= FOLLOW_MIN_STEP_PX
          ? lerpStep
          : Math.sign(diff) * FOLLOW_MIN_STEP_PX;
      scrollListToOffset(list, current + stepPx);
    }

    followRafRef.current = requestAnimationFrame(stepFollowLoop);
  }, [
    computeStreamingFollowTarget,
    readContentHeight,
    readMaxScrollOffset,
    readScrollOffset,
    scrollListToOffset,
    streaming,
  ]);

  const ensureFollowLoop = useCallback(() => {
    if (followRafRef.current === null) {
      followRafRef.current = requestAnimationFrame(stepFollowLoop);
    }
  }, [stepFollowLoop]);

  const requestFollow = useCallback(
    (options?: { allowBackward?: boolean }) => {
      if (draggingRef.current || !pinnedRef.current || lockedRef.current) {
        return;
      }

      const list = listRef.current;
      if (!list) return;

      if (streamingIndex < 0) {
        stopFollowLoop();
        requestAnimationFrame(() => list.scrollToEnd({ animated: true }));
        return;
      }

      const target = computeStreamingFollowTarget();
      if (target === null) {
        stopFollowLoop();
        return;
      }

      const current = readScrollOffset(list);
      if (
        !options?.allowBackward &&
        target <= current + 0.5
      ) {
        return;
      }

      followTargetRef.current = target;
      ensureFollowLoop();
    },
    [
      computeStreamingFollowTarget,
      ensureFollowLoop,
      readScrollOffset,
      stopFollowLoop,
      streamingIndex,
    ],
  );

  useEffect(() => () => stopFollowLoop(), [stopFollowLoop]);

  useEffect(() => {
    if (!streaming) stopFollowLoop();
  }, [streaming, stopFollowLoop]);

  const onStreamingRowLayout = useCallback(
    (height: number) => {
      if (height <= 0) return;
      const prev = streamingRowHeightRef.current;
      streamingRowHeightRef.current = height;
      if (height !== prev) requestFollow();
    },
    [requestFollow],
  );

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      offsetYRef.current = contentOffset.y;
      layoutHRef.current = layoutMeasurement.height;
      contentHRef.current = contentSize.height;

      // The "near bottom" threshold must account for the reserved tail
      // spacer below the streaming row — otherwise the send-nudge parks the
      // user just outside the flat threshold and auto-follow never engages.
      const tailReserved = streaming ? TAIL_SPACER_PX : 0;
      const hasOverflow = contentSize.height > layoutMeasurement.height + 2;
      const distFromBottom = Math.max(
        0,
        contentSize.height -
          contentOffset.y -
          layoutMeasurement.height -
          tailReserved,
      );
      const pinned =
        !hasOverflow || distFromBottom <= SCROLL_AWAY_FROM_BOTTOM_THRESHOLD;

      const wasPinned = pinnedRef.current;
      pinnedRef.current = pinned;

      if (!wasPinned && pinned && draggingRef.current) {
        lockedRef.current = false;
      }

      setAwayFromBottom(hasOverflow && !pinned);
    },
    [streaming],
  );

  const onScrollBeginDrag = useCallback(() => {
    draggingRef.current = true;
    stopFollowLoop();
  }, [stopFollowLoop]);

  const onScrollEndDrag = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const handleContentChange = useCallback(() => {
    requestFollow();
  }, [requestFollow]);

  useEffect(() => {
    if (!streaming) return;
    requestFollow();
    ensureFollowLoop();
  }, [ensureFollowLoop, streaming, streamingTextLen, requestFollow]);

  const scrollToBottom = useCallback(() => {
    lockedRef.current = false;
    stopFollowLoop();
    requestAnimationFrame(() =>
      listRef.current?.scrollToEnd({ animated: true }),
    );
  }, [stopFollowLoop]);

  const nudgeOnSend = useCallback(() => {
    lockedRef.current = false;
    requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      const current =
        typeof list.getAbsoluteLastScrollOffset === "function"
          ? list.getAbsoluteLastScrollOffset()
          : offsetYRef.current;
      list.scrollToOffset({
        offset: current + SEND_NUDGE_PX,
        animated: true,
        skipFirstItemOffset: false,
      });
    });
  }, []);

  return {
    listRef,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    handleContentChange,
    scrollToBottom,
    nudgeOnSend,
    awayFromBottom,
    streamingMessageId,
    listExtraData: streaming ? streamingTextLen : 0,
    onStreamingRowLayout,
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
  onStreamLayout,
}: {
  item: ChatMessage;
  styles: ChatStyles;
  onStreamLayout?: (height: number) => void;
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
      onLayout={
        onStreamLayout
          ? (e) => onStreamLayout(e.nativeEvent.layout.height)
          : undefined
      }
    >
      <Text
        style={styles.assistantText}
        selectable
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
      >
        {item.text}
      </Text>
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
}: {
  visible: boolean;
  hasUnread: boolean;
  onPress: () => void;
  styles: ChatStyles;
  colors: Colors;
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
  /** True while a reply is streaming — controls tail spacer + scroll model. */
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

  const scroll = useChatScroll({ messages, streaming });

  // After the viewport shrinks, keep the tail in view when the user was pinned.
  useEffect(() => {
    if (keyboardHeight <= 0 || scroll.awayFromBottom) return;
    const id = requestAnimationFrame(() => scroll.scrollToBottom());
    return () => cancelAnimationFrame(id);
  }, [keyboardHeight, scroll.awayFromBottom, scroll.scrollToBottom]);

  const [unread, setUnread] = useState(false);
  const prevLenRef = useRef(0);
  const wasStreamingRef = useRef(false);
  const spokenAssistantIdsRef = useRef<Set<string>>(new Set());

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

  // When the parent clears draft after send, collapse back to pill shape.
  useEffect(() => {
    if (expanded && draft.length === 0) {
      LayoutAnimation.configureNext(LAYOUT_SPRING);
      setExpanded(false);
    }
  }, [draft, expanded]);

  const handleContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      if (!hasMountedRef.current) {
        hasMountedRef.current = true;
        return;
      }
      const h = e.nativeEvent.contentSize.height;
      if (!expanded && h > EXPAND_THRESHOLD) {
        LayoutAnimation.configureNext(LAYOUT_SPRING);
        setExpanded(true);
      } else if (expanded && h <= EXPAND_THRESHOLD) {
        LayoutAnimation.configureNext(LAYOUT_SPRING);
        setExpanded(false);
      }
    },
    [expanded],
  );

  const submit = useCallback(() => {
    tapMedium();
    onSubmit();
  }, [onSubmit]);

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
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatMessage>) => (
      <FadeInMessage key={item.id}>
        <ChatMessageRow
          item={item}
          styles={styles}
          onStreamLayout={
            item.id === scroll.streamingMessageId
              ? scroll.onStreamingRowLayout
              : undefined
          }
        />
      </FadeInMessage>
    ),
    [scroll.onStreamingRowLayout, scroll.streamingMessageId, styles],
  );
  const renderSeparator = useCallback(
    () => <View style={styles.itemSeparator} />,
    [styles],
  );
  const getItemType = useCallback((item: ChatMessage) => item.role, []);

  // Send-time scroll nudge belongs in the parent so it lands ahead of the
  // user message render. Expose via ref through the dictation handle? For
  // simplicity, the parent re-renders on draft clear which we use as the
  // signal to nudge — but we need a stable hook. Use a layout-effect that
  // fires when messages grow with sending=true.
  const prevSendingRef = useRef(streaming);
  useEffect(() => {
    if (streaming && !prevSendingRef.current) {
      scroll.nudgeOnSend();
    }
    prevSendingRef.current = streaming;
  }, [streaming, scroll]);

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

  return (
    <View style={[styles.screen, { paddingBottom: keyboardHeight }]}>
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
              contentContainerStyle={styles.list}
              data={messages}
              extraData={scroll.listExtraData}
              renderItem={renderItem}
              keyExtractor={keyExtractor}
              getItemType={getItemType}
              ItemSeparatorComponent={renderSeparator}
              ListFooterComponent={
                streaming ? <View style={styles.tailSpacer} /> : null
              }
              onContentSizeChange={scroll.handleContentChange}
              onScroll={scroll.onScroll}
              onScrollBeginDrag={scroll.onScrollBeginDrag}
              onScrollEndDrag={scroll.onScrollEndDrag}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              keyboardDismissMode="on-drag"
              fadingEdgeLength={EDGE_FADE}
            />
            <ScrollToBottomFab
              visible={scroll.awayFromBottom}
              hasUnread={unread}
              onPress={scroll.scrollToBottom}
              styles={styles}
              colors={colors}
            />
          </>
        )}
      </View>

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
                      size={17}
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
                scrollEnabled={false}
                onChangeText={onChangeDraft}
                onContentSizeChange={handleContentSizeChange}
                blurOnSubmit
                onSubmitEditing={submit}
                returnKeyType="send"
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
                    size={17}
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
    screen: { flex: 1 },

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
      right: 16,
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
      paddingHorizontal: 20,
      paddingTop: 80,
      paddingBottom: EDGE_FADE,
    },
    tailSpacer: { height: TAIL_SPACER_PX },
    itemSeparator: { height: MESSAGE_LIST_GAP },

    emptyState: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },

    userRow: { flexDirection: "row", justifyContent: "flex-end" },
    userColumn: { alignItems: "flex-end", maxWidth: "85%" },
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
      lineHeight: 17 * 1.45,
    },
    userThumbStrip: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    userThumbsAbove: { marginBottom: 8 },
    userThumbImage: {
      backgroundColor: colors.muted,
      borderRadius: 8,
      height: 84,
      width: 84,
    },

    assistantRow: { paddingHorizontal: 4, paddingVertical: 4 },
    assistantText: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      fontWeight: "400",
      letterSpacing: 0.03 * 17,
      lineHeight: 17 * 1.45,
    },

    composerWrap: {
      alignItems: "center",
      flexShrink: 0,
      gap: 8,
      paddingBottom: 6,
      paddingHorizontal: 16,
      paddingTop: 4,
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
      maxHeight: 30,
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
