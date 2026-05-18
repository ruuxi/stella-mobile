import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { FlashList, type FlashListRef, type ListRenderItemInfo } from "@shopify/flash-list";
import { Image } from "expo-image";
import { GlassView } from "expo-glass-effect";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import Reanimated, {
  useAnimatedKeyboard,
  useAnimatedStyle,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "../../src/components/Icon";
import {
  loadComputerChatMessages,
  loadOfflineChatMessages,
  saveComputerChatMessages,
  saveOfflineChatMessages,
} from "../../src/lib/offline-chat-storage";
import { postStream, postStreamAnonymous } from "../../src/lib/http";
import { hasAiConsent, grantAiConsent } from "../../src/lib/ai-consent";
import { isGuest } from "../../src/lib/guest-mode";
import { AiConsentModal } from "../../src/components/AiConsentModal";
import { SignInPrompt } from "../../src/components/SignInPrompt";
import { getOrCreateMobileDeviceId } from "../../src/lib/phone-access";
import {
  getChatScreenMode,
  subscribeChatScreenMode,
  type ChatScreenMode,
} from "../../src/lib/chat-screen-mode";
import {
  checkDesktopConnection,
  connectToDesktop,
  getDesktopConnectionState,
  subscribeDesktopConnection,
} from "../../src/lib/desktop-connection";
import { userFacingError } from "../../src/lib/user-facing-error";
import { useDictation } from "../../src/lib/dictation";
import { DictationRecordingBar } from "../../src/components/DictationRecordingBar";
import { notifySuccess, tapMedium, tapLight } from "../../src/lib/haptics";
import { CONTENT_MAX_FONT_SCALE } from "../../src/lib/setup-text-defaults";
import { startComputerLiveActivity } from "../../src/lib/live-activity";
import { type Colors } from "../../src/theme/colors";
import { useColors } from "../../src/theme/theme-context";
import { fadeHex } from "../../src/theme/oklch";
import { fonts } from "../../src/theme/fonts";
import type { ChatMessage } from "../../src/types";
import { ConnectHeroAnimation } from "../../src/components/ConnectHeroAnimation";
import { WorkingIndicator } from "../../src/components/WorkingIndicator";

// Required for LayoutAnimation on Android
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
/** LayoutAnimation config matching the same 350ms critically-damped spring */
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Pixels from the bottom of the content past which we show “scroll to bottom”. */
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

// ---------------------------------------------------------------------------
// useChatScroll — shared scroll behavior for the chat and computer panes.
//
// Mirrors the desktop chat scroll model:
//   1. Auto-follow only while the user is pinned near the bottom; yield
//      immediately on user drag / scroll up.
//   2. Send acknowledges with a small ~48px nudge, not a snap to bottom.
//   3. While streaming, anchor the streaming assistant row's top to the
//      viewport top once it would overflow — and stop following past that
//      point so the user gets the full view of the assistant's first lines.
//   4. Defer to the native scroll view's animated scrolling for smoothing
//      that naturally adapts to actual stream rate.
// ---------------------------------------------------------------------------

function useChatScroll(opts: {
  messages: ChatMessage[];
  streaming: boolean;
}) {
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

  // Track the user message that initiated the current streaming turn so we
  // can reset the streaming anchor lock when a new turn starts.
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
        // Row layout can lag behind stream text — also check total content
        // height so follow resumes once the tail spacer budget is consumed.
        if (distFromBottom <= TAIL_SPACER_PX + FOLLOW_PAD) {
          return;
        }
        targetOffset = contentH - viewportH - TAIL_SPACER_PX;
      } else {
        targetOffset = layout.y + layout.height - viewportH + FOLLOW_PAD;
      }
    } else {
      // FlashList may not have laid out the streaming row yet — follow via
      // content height while reserving the tail spacer so we don't snap to end.
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

  // Stream deltas update message text without always changing list content
  // height synchronously — re-run follow after each chunk lands.
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
// Animated message wrapper — mirrors desktop stream-fade-blur-in
// ---------------------------------------------------------------------------

function FadeInMessage({ children }: { children: React.ReactNode }) {
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

type ChatMessageRowProps = {
  item: ChatMessage;
  styles: ReturnType<typeof makeStyles>;
};

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
  void Share.share({ message: trimmed }).catch(() => {
    // User cancelled or the share sheet was unavailable; nothing to do.
  });
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

const ChatMessageRow = memo(function ChatMessageRow({
  item,
  styles,
}: ChatMessageRowProps) {
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
  styles: ReturnType<typeof makeStyles>;
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
  styles: ReturnType<typeof makeStyles>;
  colors: Colors;
}) {
  if (!visible) {
    return null;
  }
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
      <Icon name="chevron-down" size={20} color={colors.accent} weight="semibold" />
      {hasUnread ? <View style={styles.scrollToBottomDot} /> : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function ChatScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const guest = isGuest();
  const inputRef = useRef<TextInput>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [sending, setSending] = useState(false);

  const [mode, setMode] = useState<ChatScreenMode>(() => getChatScreenMode());
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);
  const [desktopState, setDesktopState] = useState(
    () => getDesktopConnectionState(),
  );

  const [computerMessages, setComputerMessages] = useState<ChatMessage[]>([]);
  const [computerStorageLoaded, setComputerStorageLoaded] = useState(false);
  const [computerDraft, setComputerDraft] = useState("");
  const [computerSending, setComputerSending] = useState(false);

  const chatScroll = useChatScroll({ messages, streaming: sending });
  const computerScroll = useChatScroll({
    messages: computerMessages,
    streaming: computerSending,
  });

  const [chatUnread, setChatUnread] = useState(false);
  const [computerUnread, setComputerUnread] = useState(false);
  const prevChatLengthRef = useRef(0);
  const prevComputerLengthRef = useRef(0);

  const [showConsentModal, setShowConsentModal] = useState(false);
  const pendingSendRef = useRef<(() => void) | null>(null);

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  const renderChatItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatMessage>) => (
      <FadeInMessage key={item.id}>
        <ChatMessageRow item={item} styles={styles} />
      </FadeInMessage>
    ),
    [styles],
  );

  const renderComputerItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatMessage>) => (
      <FadeInMessage key={item.id}>
        <ChatMessageRow item={item} styles={styles} />
      </FadeInMessage>
    ),
    [styles],
  );

  const renderMessageSeparator = useCallback(
    () => <View style={styles.itemSeparator} />,
    [styles],
  );

  const getMessageItemType = useCallback(
    (item: ChatMessage) => item.role,
    [],
  );

  useEffect(() => {
    if (guest || mode !== "computer") {
      setMobileDeviceId(null);
      return;
    }
    void getOrCreateMobileDeviceId().then(setMobileDeviceId);
  }, [guest, mode]);

  useEffect(() => {
    return subscribeChatScreenMode(setMode);
  }, []);

  useEffect(() => {
    if (guest || mode !== "computer") {
      setDesktopState("disconnected");
      return;
    }
    return subscribeDesktopConnection(setDesktopState);
  }, [guest, mode]);

  useEffect(() => {
    if (guest || mode !== "computer") {
      return;
    }
    void checkDesktopConnection();
    const interval = setInterval(() => void checkDesktopConnection(), 15_000);
    return () => clearInterval(interval);
  }, [guest, mode]);

  // Native-driven keyboard tracking (replaces KeyboardAvoidingView)
  const insets = useSafeAreaInsets();
  const keyboard = useAnimatedKeyboard();
  const keyboardStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(0, keyboard.height.value - insets.bottom),
  }));

  // Composer expansion state — mirrors desktop Composer.tsx threshold logic
  const [expanded, setExpanded] = useState(false);
  const [computerExpanded, setComputerExpanded] = useState(false);
  const hasMountedRef = useRef(false);
  const hasMountedComputerRef = useRef(false);

  useEffect(() => {
    void loadOfflineChatMessages().then((loaded) => {
      setMessages(loaded);
      setStorageLoaded(true);
    });
    void loadComputerChatMessages().then((loaded) => {
      setComputerMessages(loaded);
      setComputerStorageLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!storageLoaded) return;
    void saveOfflineChatMessages(messages);
  }, [messages, storageLoaded]);

  useEffect(() => {
    if (!computerStorageLoaded) return;
    void saveComputerChatMessages(computerMessages);
  }, [computerMessages, computerStorageLoaded]);

  useEffect(() => {
    const grew = messages.length > prevChatLengthRef.current;
    prevChatLengthRef.current = messages.length;
    if (messages.length === 0) {
      setChatUnread(false);
      return;
    }
    if (grew && chatScroll.awayFromBottom) {
      setChatUnread(true);
    }
  }, [chatScroll.awayFromBottom, messages.length]);

  useEffect(() => {
    if (!chatScroll.awayFromBottom) setChatUnread(false);
  }, [chatScroll.awayFromBottom]);

  useEffect(() => {
    const grew = computerMessages.length > prevComputerLengthRef.current;
    prevComputerLengthRef.current = computerMessages.length;
    if (computerMessages.length === 0) {
      setComputerUnread(false);
      return;
    }
    if (grew && computerScroll.awayFromBottom) {
      setComputerUnread(true);
    }
  }, [computerScroll.awayFromBottom, computerMessages.length]);

  useEffect(() => {
    if (!computerScroll.awayFromBottom) setComputerUnread(false);
  }, [computerScroll.awayFromBottom]);

  const canSubmit = (draft.trim().length > 0 || attachments.length > 0) && !sending;

  const pickImage = async () => {
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
      setAttachments((prev) => [...prev, ...result.assets]);
    }
  };

  const removeAttachment = (uri: string) => {
    setAttachments((prev) => prev.filter((a) => a.uri !== uri));
  };

  // --------------- Send ---------------

  const send = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending) return;

    if (!hasAiConsent()) {
      pendingSendRef.current = () => void send();
      setShowConsentModal(true);
      return;
    }

    tapMedium();

    const prior = messages;
    const history = prior.map((m) => ({ role: m.role, text: m.text }));
    const assets = attachments.slice();

    const displayText = text || (assets.length ? "Photo" : "");
    const thumbs = assets.slice(0, 3).map((a) => a.uri);
    const userMsg: ChatMessage = {
      id: createId(),
      role: "user",
      text: displayText,
      hasImage: assets.length > 0,
      ...(thumbs.length > 0 ? { thumbnailUris: thumbs } : {}),
    };

    setDraft("");
    setAttachments([]);
    setSending(true);

    if (expanded) {
      LayoutAnimation.configureNext(LAYOUT_SPRING);
      setExpanded(false);
    }

    setMessages((m) => [...m, userMsg]);
    chatScroll.nudgeOnSend();

    const imagesPayload: { base64: string; mimeType: string }[] = [];
    for (const a of assets) {
      if (!a.base64) {
        setMessages((m) => [
          ...m,
          {
            id: createId(),
            role: "assistant",
            text: "Could not read that image. Try choosing it again.",
          },
        ]);
        setSending(false);
        return;
      }
      imagesPayload.push({
        base64: a.base64,
        mimeType: a.mimeType ?? "image/jpeg",
      });
    }

    const replyId = createId();
    setMessages((m) => [...m, { id: replyId, role: "assistant", text: "" }]);

    const onDelta = (delta: string) => {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === replyId ? { ...msg, text: msg.text + delta } : msg,
        ),
      );
    };

    const streamFn = guest ? postStreamAnonymous : postStream;
    const streamOptions = guest
      ? {
          headers: {
            "X-Stella-Mobile-Device-Id": await getOrCreateMobileDeviceId(),
          },
        }
      : undefined;
    try {
      await streamFn(
        "/api/mobile/offline-chat/stream",
        { message: text, history, images: imagesPayload },
        onDelta,
        streamOptions,
      );
      setMessages((m) =>
        m.map((msg) =>
          msg.id === replyId && !msg.text
            ? { ...msg, text: "No reply came back. Try again." }
            : msg,
        ),
      );
      notifySuccess();
    } catch (e) {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === replyId
            ? { ...msg, text: msg.text || userFacingError(e) }
            : msg,
        ),
      );
    } finally {
      setSending(false);
    }
  };

  // --------------- Computer Send ---------------

  const sendComputer = async () => {
    const text = computerDraft.trim();
    if (!text || computerSending || !mobileDeviceId) return;
    tapMedium();

    const userMsg: ChatMessage = {
      id: createId(),
      role: "user",
      text,
    };

    setComputerDraft("");
    setComputerSending(true);
    if (computerExpanded) {
      LayoutAnimation.configureNext(LAYOUT_SPRING);
      setComputerExpanded(false);
    }
    setComputerMessages((m) => [...m, userMsg]);
    computerScroll.nudgeOnSend();

    const replyId = createId();
    setComputerMessages((m) => [...m, { id: replyId, role: "assistant", text: "" }]);

    const activity = startComputerLiveActivity();
    let accumulated = "";

    try {
      await postStream(
        "/api/mobile/chat",
        { message: text, mobileDeviceId },
        (delta) => {
          accumulated += delta;
          activity.update(accumulated);
          setComputerMessages((m) =>
            m.map((msg) =>
              msg.id === replyId ? { ...msg, text: msg.text + delta } : msg,
            ),
          );
        },
      );
      setComputerMessages((m) =>
        m.map((msg) =>
          msg.id === replyId && !msg.text
            ? { ...msg, text: "No reply came back. Try again." }
            : msg,
        ),
      );
      activity.finish({ ok: true, preview: accumulated });
      notifySuccess();
    } catch (e) {
      setComputerMessages((m) =>
        m.map((msg) =>
          msg.id === replyId
            ? { ...msg, text: msg.text || userFacingError(e) }
            : msg,
        ),
      );
      activity.finish({ ok: false });
    } finally {
      setComputerSending(false);
    }
  };

  // --------------- TextInput content-size tracking ---------------
  // Desktop: rAF → if scrollHeight > 44 expand; if pillScrollHeight <= 44 collapse

  const handleContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      // Skip the first measurement — RN fires this on mount with an
      // unreliable initial height that can trigger a false expand.
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

  const handleComputerContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      if (!hasMountedComputerRef.current) {
        hasMountedComputerRef.current = true;
        return;
      }
      const h = e.nativeEvent.contentSize.height;
      if (!computerExpanded && h > EXPAND_THRESHOLD) {
        LayoutAnimation.configureNext(LAYOUT_SPRING);
        setComputerExpanded(true);
      } else if (computerExpanded && h <= EXPAND_THRESHOLD) {
        LayoutAnimation.configureNext(LAYOUT_SPRING);
        setComputerExpanded(false);
      }
    },
    [computerExpanded],
  );

  // --------------- Voice input (Voxtral via /api/mobile/transcribe) ---------------

  const dictationHeaders = useMemo(() => {
    if (!guest || !mobileDeviceId) return undefined;
    return { "X-Stella-Mobile-Device-Id": mobileDeviceId };
  }, [guest, mobileDeviceId]);

  const appendTranscript = useCallback(
    (text: string) => {
      const target = mode === "chat" ? setDraft : setComputerDraft;
      target((prev) => {
        const trimmedPrev = prev.trimEnd();
        if (!trimmedPrev) return text;
        return `${trimmedPrev} ${text}`;
      });
    },
    [mode],
  );

  const dictation = useDictation({
    anonymous: guest,
    headers: dictationHeaders,
    onTranscript: appendTranscript,
  });

  const isListening = dictation.isRecording;

  const toggleVoice = useCallback(async () => {
    if (dictation.status === "idle") {
      tapLight();
    }
    await dictation.toggle();
  }, [dictation]);

  const onConsentAccept = () => {
    void grantAiConsent().then(() => {
      setShowConsentModal(false);
      const pending = pendingSendRef.current;
      pendingSendRef.current = null;
      if (pending) pending();
    });
  };

  const onConsentDecline = () => {
    pendingSendRef.current = null;
    setShowConsentModal(false);
  };

  const empty = messages.length === 0;

  // =====================================================================
  // Render
  // =====================================================================

  const computerEmpty = computerMessages.length === 0;
  const canSubmitComputer = computerDraft.trim().length > 0 && !computerSending;

  return (
    <Reanimated.View style={[styles.screen, keyboardStyle]}>
      {mode === "chat" ? (
        <>
          {/* ---------- Chat Conversation ---------- */}
          <View style={styles.viewport}>
            {empty ? (
              <Pressable style={styles.emptyState} onPress={() => Keyboard.dismiss()}>
                <Text style={styles.emptyText}>Ask Stella anything</Text>
              </Pressable>
            ) : (
              <>
                <FlashList
                  ref={chatScroll.listRef}
                  contentContainerStyle={styles.list}
                  data={messages}
                  renderItem={renderChatItem}
                  keyExtractor={keyExtractor}
                  getItemType={getMessageItemType}
                  ItemSeparatorComponent={renderMessageSeparator}
                  ListFooterComponent={
                    sending ? <View style={styles.tailSpacer} /> : null
                  }
                  onContentSizeChange={chatScroll.handleContentChange}
                  onScroll={chatScroll.onScroll}
                  onScrollBeginDrag={chatScroll.onScrollBeginDrag}
                  onScrollEndDrag={chatScroll.onScrollEndDrag}
                  scrollEventThrottle={16}
                  showsVerticalScrollIndicator={false}
                  keyboardDismissMode="on-drag"
                  fadingEdgeLength={EDGE_FADE}
                />
                <ScrollToBottomFab
                  visible={chatScroll.awayFromBottom}
                  hasUnread={chatUnread}
                  onPress={chatScroll.scrollToBottom}
                  styles={styles}
                  colors={colors}
                />
              </>
            )}
          </View>

      {/* ---------- Composer ---------- */}
      {/*
        Desktop structure (full-shell.composer.css):
          .composer            → centering wrapper, padding 8 24 16
          .composer-shell      → pill/rect, shadow, overflow clip, animated h + radius
            .composer-form     → row (pill) or column (expanded)
              [add] [input] [toolbar: [add-toolbar] [stop] [submit]]
      */}
      <WorkingIndicator active={sending} />
      <View style={[styles.composerWrap, { paddingBottom: 6 + insets.bottom }]}>
        {attachments.length > 0 && (
          <View style={styles.attachmentStrip}>
            {attachments.map((asset) => (
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
                  <Icon name="x" size={12} color={colors.accentForeground} weight="bold" />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        {(() => {
          const hasText = draft.trim().length > 0;
          // Mirror desktop: replace pill content with the dictation bar when
          // recording with no text; render it as an extra row below when
          // recording with text (forces expanded layout).
          const dictationInline = isListening && !hasText;
          const dictationBelow = isListening && hasText;
          const isExpandedComposed = expanded || dictationBelow;
          return (
            <GlassView
              style={[
                styles.shell,
                isExpandedComposed ? styles.shellExpanded : styles.shellPill,
              ]}
            >
              {dictationInline ? (
                /* ---- Dictation: replaces the pill contents ---- */
                <View style={styles.formPill}>
                  <Pressable
                    style={styles.addButton}
                    hitSlop={4}
                    accessibilityLabel="Attach a photo"
                    onPress={() => void pickImage()}
                  >
                    <Icon name="plus" size={16} color={colors.textMuted} weight="semibold" />
                  </Pressable>
                  <DictationRecordingBar
                    levels={dictation.levels}
                    elapsedMs={dictation.elapsedMs}
                    onCancel={() => void dictation.cancel()}
                    onConfirm={() => void dictation.stop()}
                  />
                </View>
              ) : isExpandedComposed ? (
                /* ---- Expanded: column, textarea on top, toolbar below ---- */
                <View style={styles.formExpanded}>
                  <TextInput
                    ref={inputRef}
                    multiline
                    onChangeText={setDraft}
                    onContentSizeChange={handleContentSizeChange}
                    blurOnSubmit={false}
                    placeholder="Message Stella"
                    placeholderTextColor={fadeHex(colors.textMuted, 0.35)}
                    selectionColor={colors.accent}
                    underlineColorAndroid="transparent"
                    style={styles.inputExpanded}
                    value={draft}
                  />
                  <View style={styles.toolbar}>
                    <View style={styles.toolbarLeft}>
                      <Pressable
                        style={styles.addButton}
                        hitSlop={4}
                        accessibilityLabel="Attach a photo"
                        onPress={() => void pickImage()}
                      >
                        <Icon name="plus" size={16} color={colors.textMuted} weight="semibold" />
                      </Pressable>
                    </View>
                    <View style={styles.toolbarRight}>
                      <Pressable
                        onPress={() => void toggleVoice()}
                        accessibilityLabel={
                          isListening ? "Stop voice input" : "Start voice input"
                        }
                        disabled={dictation.isTranscribing}
                        style={[styles.micButton, isListening && styles.micButtonActive]}
                        hitSlop={4}
                      >
                        <Icon
                          name={isListening ? "mic-off" : "mic"}
                          size={16}
                          color={isListening ? colors.accentForeground : colors.textMuted}
                          filled={isListening}
                        />
                      </Pressable>
                      <AnimatedSubmitButton
                        canSubmit={canSubmit}
                        onPress={() => void send()}
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
                /* ---- Pill: single row, input + submit ---- */
                <View style={styles.formPill}>
                  <Pressable
                    style={styles.addButton}
                    hitSlop={4}
                    accessibilityLabel="Attach a photo"
                    onPress={() => void pickImage()}
                  >
                    <Icon name="plus" size={16} color={colors.textMuted} weight="semibold" />
                  </Pressable>
                  <TextInput
                    ref={inputRef}
                    scrollEnabled={false}
                    onChangeText={setDraft}
                    onContentSizeChange={handleContentSizeChange}
                    blurOnSubmit
                    onSubmitEditing={() => void send()}
                    returnKeyType="send"
                    placeholder={
                      dictation.isTranscribing ? "Transcribing\u2026" : "Message Stella"
                    }
                    placeholderTextColor={fadeHex(colors.textMuted, 0.35)}
                    selectionColor={colors.accent}
                    underlineColorAndroid="transparent"
                    style={styles.inputPill}
                    value={draft}
                  />
                  {canSubmit ? (
                    <AnimatedSubmitButton
                      canSubmit={canSubmit}
                      onPress={() => void send()}
                      styles={styles}
                      colors={colors}
                      accessibilityLabel="Send message"
                    />
                  ) : (
                    <Pressable
                      onPress={() => void toggleVoice()}
                      accessibilityLabel="Start voice input"
                      disabled={dictation.isTranscribing}
                      style={styles.micButton}
                      hitSlop={4}
                    >
                      <Icon
                        name="mic"
                        size={16}
                        color={colors.textMuted}
                      />
                    </Pressable>
                  )}
                </View>
              )}
            </GlassView>
          );
        })()}
      </View>
        </>
      ) : guest ? (
        <View style={styles.viewport}>
          <Pressable style={styles.emptyState} onPress={() => Keyboard.dismiss()}>
            <ConnectHeroAnimation />
            <Text style={styles.emptyText}>Your computer, at your fingertips</Text>
            <Text style={styles.computerSubtext}>
              Ask Stella to do things on your computer — browse the web, manage files, run tasks, and more.
            </Text>
            <SignInPrompt message="Sign in to get started." />
          </Pressable>
        </View>
      ) : (
        <>
          {/* ---------- Computer Pane ---------- */}
          <View style={styles.viewport}>
            {computerEmpty ? (
              <Pressable style={styles.emptyState} onPress={() => Keyboard.dismiss()}>
                {desktopState === "connected" ? (
                  <>
                    <ConnectHeroAnimation />
                    <Text style={styles.emptyText}>Your computer, at your fingertips</Text>
                    <Text style={styles.computerSubtext}>
                      Ask Stella to do things on your computer — browse the web, manage files, run tasks, and more.
                    </Text>
                  </>
                ) : desktopState === "connecting" ? (
                  <>
                    <ConnectHeroAnimation />
                    <Text style={styles.emptyText}>Connecting...</Text>
                    <Text style={styles.computerSubtext}>
                      Looking for your computer. Make sure Stella is running on your desktop.
                    </Text>
                  </>
                ) : (
                  <>
                    <ConnectHeroAnimation />
                    <Text style={styles.emptyText}>Your computer, at your fingertips</Text>
                    <Text style={styles.computerSubtext}>
                      Ask Stella to do things on your computer — browse the web, manage files, run tasks, and more.
                    </Text>
                    <Pressable
                      style={styles.connectButton}
                      onPress={() => void connectToDesktop()}
                    >
                      <Text style={styles.connectButtonText}>Connect</Text>
                    </Pressable>
                  </>
                )}
              </Pressable>
            ) : (
              <>
                <FlashList
                  ref={computerScroll.listRef}
                  contentContainerStyle={styles.list}
                  data={computerMessages}
                  renderItem={renderComputerItem}
                  keyExtractor={keyExtractor}
                  getItemType={getMessageItemType}
                  ItemSeparatorComponent={renderMessageSeparator}
                  ListFooterComponent={
                    computerSending ? <View style={styles.tailSpacer} /> : null
                  }
                  onContentSizeChange={computerScroll.handleContentChange}
                  onScroll={computerScroll.onScroll}
                  onScrollBeginDrag={computerScroll.onScrollBeginDrag}
                  onScrollEndDrag={computerScroll.onScrollEndDrag}
                  scrollEventThrottle={16}
                  showsVerticalScrollIndicator={false}
                  keyboardDismissMode="on-drag"
                  fadingEdgeLength={EDGE_FADE}
                />
                <ScrollToBottomFab
                  visible={computerScroll.awayFromBottom}
                  hasUnread={computerUnread}
                  onPress={computerScroll.scrollToBottom}
                  styles={styles}
                  colors={colors}
                />
              </>
            )}
          </View>

          {/* Computer Composer — same pill/expand structure as Chat, sans images. */}
          <WorkingIndicator active={computerSending} />
          <View style={[styles.composerWrap, { paddingBottom: 6 + insets.bottom }]}>
            {(() => {
              const hasText = computerDraft.trim().length > 0;
              const dictationInlineComputer = isListening && !hasText;
              const dictationBelowComputer = isListening && hasText;
              const isExpandedComputer = computerExpanded || dictationBelowComputer;
              return (
            <GlassView
              style={[
                styles.shell,
                isExpandedComputer ? styles.shellExpanded : styles.shellPill,
              ]}
            >
              {dictationInlineComputer ? (
                <View style={styles.formPill}>
                  <DictationRecordingBar
                    levels={dictation.levels}
                    elapsedMs={dictation.elapsedMs}
                    onCancel={() => void dictation.cancel()}
                    onConfirm={() => void dictation.stop()}
                  />
                </View>
              ) : isExpandedComputer ? (
                <View style={styles.formExpanded}>
                  <TextInput
                    multiline
                    onChangeText={setComputerDraft}
                    onContentSizeChange={handleComputerContentSizeChange}
                    blurOnSubmit={false}
                    placeholder={
                      desktopState === "connected"
                        ? "Ask Stella to do something"
                        : "Connect to your computer first"
                    }
                    placeholderTextColor={fadeHex(colors.textMuted, 0.35)}
                    selectionColor={colors.accent}
                    underlineColorAndroid="transparent"
                    style={styles.inputExpanded}
                    value={computerDraft}
                    editable={desktopState === "connected"}
                  />
                  <View style={styles.toolbar}>
                    <View style={styles.toolbarLeft} />
                    <View style={styles.toolbarRight}>
                      <Pressable
                        onPress={() => void toggleVoice()}
                        accessibilityLabel={
                          isListening ? "Stop voice input" : "Start voice input"
                        }
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
                            isListening
                              ? colors.accentForeground
                              : colors.textMuted
                          }
                          filled={isListening}
                        />
                      </Pressable>
                      <AnimatedSubmitButton
                        canSubmit={
                          canSubmitComputer && desktopState === "connected"
                        }
                        onPress={() => void sendComputer()}
                        styles={styles}
                        colors={colors}
                        accessibilityLabel="Send message to your computer"
                      />
                    </View>
                  </View>
                  {dictationBelowComputer && (
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
                  <TextInput
                    scrollEnabled={false}
                    onChangeText={setComputerDraft}
                    onContentSizeChange={handleComputerContentSizeChange}
                    blurOnSubmit
                    onSubmitEditing={() => void sendComputer()}
                    returnKeyType="send"
                    placeholder={
                      dictation.isTranscribing
                        ? "Transcribing\u2026"
                        : desktopState === "connected"
                          ? "Ask Stella to do something"
                          : "Connect to your computer first"
                    }
                    placeholderTextColor={fadeHex(colors.textMuted, 0.35)}
                    selectionColor={colors.accent}
                    underlineColorAndroid="transparent"
                    style={styles.inputPill}
                    value={computerDraft}
                    editable={desktopState === "connected"}
                  />
                  {canSubmitComputer ? (
                    <AnimatedSubmitButton
                      canSubmit={desktopState === "connected"}
                      onPress={() => void sendComputer()}
                      styles={styles}
                      colors={colors}
                      accessibilityLabel="Send message to your computer"
                    />
                  ) : (
                    <Pressable
                      onPress={() => void toggleVoice()}
                      accessibilityLabel={
                        isListening ? "Stop voice input" : "Start voice input"
                      }
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
                          isListening
                            ? colors.accentForeground
                            : colors.textMuted
                        }
                        filled={isListening}
                      />
                    </Pressable>
                  )}
                </View>
              )}
            </GlassView>
              );
            })()}
          </View>
        </>
      )}

      <AiConsentModal
        visible={showConsentModal}
        onAccept={onConsentAccept}
        onDecline={onConsentDecline}
      />
    </Reanimated.View>
  );
}

// ---------------------------------------------------------------------------
// Styles
//
// Desktop mapping:
//   .composer-shell      → shell (pill capsule, shadow, overflow hidden)
//   .composer-form       → formPill (row, 48 min-h, padding 8, gap 8)
//   .composer-form.expanded → formExpanded (column)
//   .composer-input      → inputPill (flex 1, padding 4)
//   .composer-form.expanded .composer-input → inputExpanded (14 18 4, min-h 44)
//   .composer-add-button → addButton (30x30, dashed border)
//   .composer-submit     → submitButton (30x30, primary bg)
//   .composer-toolbar    → toolbar (row, padding 4 8 8)
// ---------------------------------------------------------------------------

const EDGE_FADE = 48;
const MESSAGE_LIST_GAP = 20;

const makeStyles = (colors: Colors) => StyleSheet.create({
  screen: {
    flex: 1,
  },

  // Computer pane empty state extras
  computerSubtext: {
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    color: colors.textMuted,
    textAlign: "center",
    lineHeight: 22,
    maxWidth: 280,
    marginTop: 8,
  },
  connectButton: {
    marginTop: 20,
    paddingVertical: 10,
    paddingHorizontal: 28,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  connectButtonText: {
    fontFamily: fonts.sans.medium,
    fontSize: 15,
    color: colors.accentForeground,
    letterSpacing: -0.2,
  },

  // Conversation — desktop: .session-messages { gap: 24px; padding: 112px 24px 24px }
  viewport: {
    flex: 1,
    position: "relative",
  },
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
  scrollToBottomFabPressed: {
    opacity: 0.88,
  },
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
  tailSpacer: {
    height: TAIL_SPACER_PX,
  },
  itemSeparator: {
    height: MESSAGE_LIST_GAP,
  },
  emptyState: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  emptyText: {
    color: colors.textMuted,
    fontFamily: fonts.display.regularItalic,
    fontSize: 22,
    letterSpacing: -0.5,
    opacity: 0.45,
  },

  // User bubble — desktop: .event-item.user
  //   padding: 12, border-radius 18 / tail 4, color-mix(primary 10%), border borderStrong, max-width 85%
  userRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
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
  userThumbStrip: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  userThumbsAbove: {
    marginBottom: 8,
  },
  userThumbImage: {
    backgroundColor: colors.muted,
    borderRadius: 8,
    height: 84,
    width: 84,
  },

  // Assistant — desktop: .event-item.assistant
  //   transparent bg, no border, full width, tail bottom-left 4px
  assistantRow: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  assistantText: {
    color: colors.text,
    fontFamily: fonts.sans.regular,
    fontSize: 17,
    fontWeight: "400",
    letterSpacing: 0.03 * 17,
    lineHeight: 17 * 1.45,
  },

  // ---- Composer ----

  // Desktop: .composer { padding: 4px 24px 10px; gap: 8px }
  // Bottom inset for the home indicator gets layered on inline below.
  composerWrap: {
    alignItems: "center",
    flexShrink: 0,
    gap: 8,
    paddingBottom: 6,
    paddingHorizontal: 16,
    paddingTop: 4,
  },

  // Attachment preview strip
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
  attachmentImage: {
    borderRadius: 10,
    height: 64,
    width: 64,
  },
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

  // Shell — desktop: .composer-shell {
  //   background: var(--background);
  //   border: 1px solid color-mix(border 60%, transparent);
  //   box-shadow: var(--shadow-md);
  //   overflow: clip;
  // }
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
  shellPill: {
    borderRadius: 999,
  },
  shellExpanded: {
    borderRadius: 20,
  },

  // Desktop: .composer-form { min-height: 46px; padding: 7px 8px; gap: 8px }
  formPill: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    minHeight: 46,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },

  formExpanded: {
    flexDirection: "column",
  },

  // Desktop: .composer-input { font-size: 14px; line-height: 1.5; min-h: 28px; max-h: 200px; padding: 2px 4px }
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
    ...(Platform.OS === "android" ? { textAlignVertical: "center" as const } : {}),
  },

  // Desktop: .composer-form.expanded .composer-input { padding: 10px 16px 2px; min-height: 36px }
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

  // Desktop: .composer-form.expanded .composer-toolbar { padding: 2px 8px 6px; space-between }
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 6,
    paddingHorizontal: 8,
    paddingTop: 2,
  },
  toolbarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  toolbarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  // Desktop: .composer-dictation-row (only used in expanded mode when text is present)
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

  // Desktop: .chat-composer-icon-button--add { background: color-mix(foreground 6%, transparent) }
  addButton: {
    alignItems: "center",
    backgroundColor: fadeHex(colors.text, 0.06),
    borderRadius: 15,
    height: 30,
    justifyContent: "center",
    width: 30,
  },

  // Desktop: .chat-composer-icon-button--submit { 30x30, primary bg }
  submitButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 15,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  // Desktop: .chat-composer-icon-button--mic { background: transparent }
  micButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderRadius: 15,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  micButtonActive: {
    backgroundColor: colors.accent,
  },
} as const);
