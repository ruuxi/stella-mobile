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
  Keyboard,
  LayoutAnimation,
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
import Reanimated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./Icon";
import { DictationRecordingBar } from "./DictationRecordingBar";
import { WorkingIndicator } from "./WorkingIndicator";
import { useDictation } from "../lib/dictation";
import { notifySuccess, tapMedium, tapLight } from "../lib/haptics";
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
 * fontSize 14 × lineHeight 1.5 ≈ 21 per line → two lines ≈ 42.
 * Use a value just above two lines so single-line typing stays pill.
 */
const EXPAND_THRESHOLD = 44;
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
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  const streamingIndex = streaming ? messages.length - 1 : -1;
  const streamingTextLen =
    streamingIndex >= 0 ? messages[streamingIndex]?.text.length ?? 0 : 0;

  const lastUserIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i;
    }
    return -1;
  }, [messages]);

  useEffect(() => {
    if (streaming) lockedRef.current = false;
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

  const tickFollow = useCallback(() => {
    if (draggingRef.current) return;
    if (!pinnedRef.current) return;
    if (lockedRef.current) return;

    const list = listRef.current;
    if (!list) return;

    const viewportH = layoutHRef.current || list.getWindowSize().height || 0;
    if (viewportH <= 0) return;

    const contentH = readContentHeight(list);
    if (contentH <= 0) return;
    contentHRef.current = contentH;

    const currentOffset = readScrollOffset(list);
    const FOLLOW_PAD = 24;

    if (streamingIndex < 0) {
      requestAnimationFrame(() => list.scrollToEnd({ animated: true }));
      return;
    }

    const layout = list.getLayout(streamingIndex);

    if (layout && layout.y <= currentOffset + 2) {
      lockedRef.current = true;
      return;
    }

    const distFromBottom = contentH - currentOffset - viewportH;
    let targetOffset: number;

    if (layout && layout.height > 0) {
      const streamingBottomInViewport =
        layout.y + layout.height - currentOffset;
      if (streamingBottomInViewport < viewportH - FOLLOW_PAD) {
        if (distFromBottom <= TAIL_SPACER_PX + FOLLOW_PAD) {
          return;
        }
        targetOffset = contentH - viewportH - TAIL_SPACER_PX;
      } else {
        targetOffset = layout.y + layout.height - viewportH + FOLLOW_PAD;
      }
    } else {
      if (distFromBottom <= TAIL_SPACER_PX + FOLLOW_PAD) {
        return;
      }
      targetOffset = contentH - viewportH - TAIL_SPACER_PX;
    }

    if (targetOffset <= currentOffset + 1) return;

    requestAnimationFrame(() => {
      list.scrollToOffset({
        offset: Math.max(0, targetOffset),
        animated: true,
        skipFirstItemOffset: false,
      });
    });
  }, [readContentHeight, readScrollOffset, streamingIndex]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      offsetYRef.current = contentOffset.y;
      layoutHRef.current = layoutMeasurement.height;
      contentHRef.current = contentSize.height;

      const hasOverflow = contentSize.height > layoutMeasurement.height + 2;
      const distFromBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height;
      const pinned =
        !hasOverflow || distFromBottom <= SCROLL_AWAY_FROM_BOTTOM_THRESHOLD;

      const wasPinned = pinnedRef.current;
      pinnedRef.current = pinned;

      if (!wasPinned && pinned && draggingRef.current) {
        lockedRef.current = false;
      }

      setAwayFromBottom(hasOverflow && !pinned);
    },
    [],
  );

  const onScrollBeginDrag = useCallback(() => {
    draggingRef.current = true;
  }, []);

  const onScrollEndDrag = useCallback(() => {
    draggingRef.current = false;
  }, []);

  const handleContentChange = useCallback(() => {
    tickFollow();
  }, [tickFollow]);

  useEffect(() => {
    if (!streaming) return;
    tickFollow();
  }, [streaming, streamingTextLen, tickFollow]);

  const scrollToBottom = useCallback(() => {
    lockedRef.current = false;
    requestAnimationFrame(() =>
      listRef.current?.scrollToEnd({ animated: true }),
    );
  }, []);

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
      (index) => {
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
}: {
  item: ChatMessage;
  styles: ChatStyles;
}) {
  if (item.role === "user") {
    const thumbs = item.thumbnailUris ?? [];
    const showThumbs = thumbs.length > 0;
    const showText = item.text.trim().length > 0;
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
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
      <Text
        style={styles.assistantText}
        selectable
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
      >
        {item.text}
      </Text>
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
          size={14}
          color={colors.accentForeground}
          weight="heavy"
        />
      </Pressable>
    </Animated.View>
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
// ---------------------------------------------------------------------------

type PlusMenuOption = {
  id: string;
  label: string;
  onSelect: () => void;
};

const openPlusMenu = (options: PlusMenuOption[]) => {
  if (options.length === 0) return;
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [...options.map((o) => o.label), "Cancel"],
        cancelButtonIndex: options.length,
      },
      (index) => {
        const picked = options[index];
        if (picked) picked.onSelect();
      },
    );
    return;
  }
  Alert.alert("Add", undefined, [
    ...options.map((o) => ({ text: o.label, onPress: o.onSelect })),
    { text: "Cancel", style: "cancel" as const },
  ]);
};

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
  enableAttachments,
  attachments,
  onChangeAttachments,
  onViewComputer,
  dictationAnonymous,
  dictationHeaders,
}: ChatPaneProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const inputRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const keyboardStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(0, keyboard.height.value - insets.bottom),
  }));

  const scroll = useChatScroll({ messages, streaming });

  const [unread, setUnread] = useState(false);
  const prevLenRef = useRef(0);

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

  const onPressPlus = useCallback(() => {
    const options: PlusMenuOption[] = [];
    if (enableAttachments) {
      options.push({
        id: "attach-photo",
        label: "Attach a photo",
        onSelect: () => void pickImage(),
      });
    }
    if (onViewComputer) {
      options.push({
        id: "view-computer",
        label: "View computer",
        onSelect: onViewComputer,
      });
    }
    if (options.length === 0) return;
    if (options.length === 1 && options[0].id === "attach-photo") {
      // Single-action: fall straight through so the menu doesn't add friction.
      void pickImage();
      return;
    }
    openPlusMenu(options);
  }, [enableAttachments, onViewComputer, pickImage]);

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatMessage>) => (
      <FadeInMessage key={item.id}>
        <ChatMessageRow item={item} styles={styles} />
      </FadeInMessage>
    ),
    [styles],
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

  const hasPlusMenu = enableAttachments || Boolean(onViewComputer);

  const plusButton = hasPlusMenu ? (
    <Pressable
      style={styles.addButton}
      hitSlop={4}
      accessibilityLabel="Open add menu"
      onPress={onPressPlus}
    >
      <Icon name="plus" size={16} color={colors.textMuted} weight="semibold" />
    </Pressable>
  ) : null;

  const showAttachmentStrip =
    enableAttachments && (attachments?.length ?? 0) > 0;

  return (
    <Reanimated.View style={[styles.screen, keyboardStyle]}>
      <View style={styles.viewport}>
        {empty ? (
          <Pressable style={styles.emptyState} onPress={() => Keyboard.dismiss()}>
            {emptyContent}
          </Pressable>
        ) : (
          <>
            <FlashList
              ref={scroll.listRef}
              contentContainerStyle={styles.list}
              data={messages}
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
      <View style={[styles.composerWrap, { paddingBottom: 6 + insets.bottom }]}>
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
                      size={16}
                      color={
                        isListening ? colors.accentForeground : colors.textMuted
                      }
                      filled={isListening}
                    />
                  </Pressable>
                  <AnimatedSubmitButton
                    canSubmit={canSubmit}
                    onPress={submit}
                    styles={styles}
                    colors={colors}
                    accessibilityLabel="Send message"
                  />
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
              {canSubmit ? (
                <AnimatedSubmitButton
                  canSubmit={canSubmit}
                  onPress={submit}
                  styles={styles}
                  colors={colors}
                  accessibilityLabel="Send message"
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
                    size={16}
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
    </Reanimated.View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1 },

    viewport: { flex: 1, position: "relative" },
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
    userBubble: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.borderStrong,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 18,
      borderBottomRightRadius: 4,
      maxWidth: "85%",
      padding: 12,
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
      minHeight: 46,
      paddingHorizontal: 8,
      paddingVertical: 7,
    },
    formExpanded: { flexDirection: "column" },

    inputPill: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      lineHeight: 21,
      maxHeight: 28,
      paddingHorizontal: 4,
      paddingVertical: 0,
      ...(Platform.OS === "android"
        ? { textAlignVertical: "center" as const }
        : {}),
    },
    inputExpanded: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      lineHeight: 22,
      maxHeight: 200,
      minHeight: 36,
      paddingHorizontal: 16,
      paddingTop: 10,
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
      borderRadius: 15,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    submitButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 15,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    micButton: {
      alignItems: "center",
      backgroundColor: "transparent",
      borderRadius: 15,
      height: 30,
      justifyContent: "center",
      width: 30,
    },
    micButtonActive: { backgroundColor: colors.accent },
  } as const);
