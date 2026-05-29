import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import {
  loadComputerChatMessages,
  saveComputerChatMessages,
} from "../../src/lib/offline-chat-storage";
import { isGuest } from "../../src/lib/guest-mode";
import { SignInPrompt } from "../../src/components/SignInPrompt";
import {
  getPreferredPhoneAccess,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import {
  loadDesktopBridgeChatMessages,
  normalizeDesktopChatMessageText,
  sendDesktopBridgeChat,
} from "../../src/lib/desktop-bridge-chat";
import { userFacingError } from "../../src/lib/user-facing-error";
import { notifySuccess } from "../../src/lib/haptics";
import { useComputerModelSettings } from "../../src/lib/use-computer-model-settings";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import type { ChatMessage } from "../../src/types";
import { ChatPane } from "../../src/components/ChatPane";
import { ComputerSettingsSheet } from "../../src/components/ComputerSettingsSheet";
import { ConnectHeroAnimation } from "../../src/components/ConnectHeroAnimation";
import { PairPhoneSheet } from "../../src/components/PairPhoneSheet";

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export default function ComputerChatScreen() {
  const guest = isGuest();
  if (guest) {
    return <GuestComputerChat />;
  }
  return <AuthenticatedComputerChat />;
}

function GuestComputerChat() {
  const colors = useColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        // The hero (animated SVG + copy) and the sign-in CTA are independent
        // sections so tuning one never shifts the other. The hero owns the
        // flexible upper region; the CTA anchors toward the bottom.
        container: {
          flex: 1,
          justifyContent: "center",
          width: "100%",
        },
        heroSection: {
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 32,
        },
        signInSection: {
          alignItems: "center",
          marginTop: 28,
          paddingHorizontal: 32,
        },
        title: {
          color: colors.textMuted,
          fontFamily: fonts.display.regularItalic,
          fontSize: 22,
          letterSpacing: -0.5,
          opacity: 0.7,
          textAlign: "center",
        },
        body: {
          color: colors.textMuted,
          fontFamily: fonts.sans.regular,
          fontSize: 15,
          letterSpacing: -0.2,
          lineHeight: 22,
          maxWidth: 280,
          textAlign: "center",
        },
      }),
    [colors],
  );
  return (
    <ChatPane
      messages={[]}
      streaming={false}
      emptyContent={
        <View style={styles.container}>
          <View style={styles.heroSection}>
            <ConnectHeroAnimation />
            <Text style={styles.title}>Your computer, at your fingertips</Text>
            <Text style={styles.body}>
              Ask Stella to do things on your computer — browse the web, manage
              files, run tasks, and more.
            </Text>
          </View>
          <View style={styles.signInSection}>
            <SignInPrompt />
          </View>
        </View>
      }
      draft=""
      onChangeDraft={() => {}}
      canSubmit={false}
      onSubmit={() => {}}
      placeholder="Sign in to message your computer"
      enableAttachments={false}
      composerEnabled={false}
      dictationAnonymous
    />
  );
}

type QueuedSend = {
  dispatchId: string;
  userMessageId: string;
  text: string;
};

/** Cap on how many desktop messages we render after a sync. */
const HISTORY_MESSAGE_LIMIT = 100;

function AuthenticatedComputerChat() {
  const colors = useColors();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [paired, setPaired] = useState<boolean | null>(null);
  const [phoneAccess, setPhoneAccess] = useState<StoredPhoneAccess | null>(
    null,
  );
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  // One-shot desktop history sync state. `syncing` controls the spinner;
  // `didMountSync` is a guard so the sync runs exactly once per tab landing
  // once the bridge preconditions are ready.
  const [syncing, setSyncing] = useState(false);
  const didMountSyncRef = useRef(false);
  const modelSettings = useComputerModelSettings();
  // Local follow-up queue (mirrors the chat screen). The Convex `sendChat`
  // path is bypassed here: messages and history go straight to the paired
  // desktop bridge, while Convex remains pairing/tunnel discovery only.
  const queueRef = useRef<QueuedSend[]>([]);
  const stoppedDispatchIdsRef = useRef<Set<string>>(new Set());
  const activeDispatchRef = useRef<{
    dispatchId: string;
    replyId: string;
    abort: AbortController;
  } | null>(null);
  // Forward declaration so `dispatch` can call the latest `drainQueue`
  // without depending on its identity (which would create a callback cycle).
  const drainQueueRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void getPreferredPhoneAccess().then((access) => {
      setPhoneAccess(access);
      setPaired(Boolean(access));
    });
  }, []);

  useEffect(() => {
    void loadComputerChatMessages().then((loaded) => {
      setMessages(
        loaded
          .map((message) => ({
            ...message,
            text: normalizeDesktopChatMessageText(message.text),
          }))
          .filter((message) => message.text.length > 0),
      );
      setStorageLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!storageLoaded) return;
    void saveComputerChatMessages(messages);
  }, [messages, storageLoaded]);

  // ─── Desktop chat snapshot sync ────────────────────────────────────────
  // On tab focus while idle, ask the desktop bridge for its current chat.
  // The transcript comes from the paired desktop over the tunnel; Convex is
  // used only to wake/discover/authorize the bridge.
  useEffect(() => {
    if (didMountSyncRef.current) return;
    if (!storageLoaded) return;
    if (paired !== true) return;
    if (!phoneAccess) return;
    if (sending) return;

    didMountSyncRef.current = true;
    let cancelled = false;
    setSyncing(true);
    void (async () => {
      try {
        const next = await loadDesktopBridgeChatMessages(
          phoneAccess,
          HISTORY_MESSAGE_LIMIT,
        );
        if (cancelled) return;
        setMessages(next);
        setSyncing(false);
      } catch {
        if (cancelled) return;
        setSyncing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [paired, phoneAccess, sending, storageLoaded]);

  const dispatch = useCallback(
    async (item: QueuedSend) => {
      // Promote the queued bubble (if any) out of the dimmed state and
      // add an empty assistant placeholder beside it.
      const replyId = createId();
      const abort = new AbortController();
      activeDispatchRef.current = {
        dispatchId: item.dispatchId,
        replyId,
        abort,
      };
      setMessages((m) => [
        ...m.map((msg) =>
          msg.id === item.userMessageId ? { ...msg, queued: false } : msg,
        ),
        { id: replyId, role: "assistant", text: "" },
      ]);

      if (!phoneAccess) {
        activeDispatchRef.current = null;
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId
              ? {
                  ...msg,
                  text: "Pair this phone with your desktop again.",
                }
              : msg,
          ),
        );
        setSending(false);
        drainQueueRef.current?.();
        return;
      }

      try {
        const result = await sendDesktopBridgeChat({
          access: phoneAccess,
          message: item.text,
          signal: abort.signal,
        });
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          activeDispatchRef.current = null;
          setSending(false);
          return;
        }
        activeDispatchRef.current = null;
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId ? { ...msg, text: result.text } : msg,
          ),
        );
        notifySuccess();
        setSending(false);
        drainQueueRef.current?.();
      } catch (e) {
        activeDispatchRef.current = null;
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          setSending(false);
          return;
        }
        const message = userFacingError(e);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId ? { ...msg, text: message } : msg,
          ),
        );
        setSending(false);
        drainQueueRef.current?.();
      }
    },
    [phoneAccess],
  );

  const drainQueue = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) return;
    setSending(true);
    void dispatch(next);
  }, [dispatch]);

  useEffect(() => {
    drainQueueRef.current = drainQueue;
  }, [drainQueue]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !phoneAccess) return;

    const userMessageId = createId();
    const userMsg: ChatMessage = {
      id: userMessageId,
      role: "user",
      text,
      ...(sending ? { queued: true } : {}),
    };

    setDraft("");
    LayoutAnimation.configureNext({
      duration: 350,
      update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
    });
    setMessages((m) => [...m, userMsg]);

    const item: QueuedSend = { dispatchId: createId(), userMessageId, text };
    if (sending) {
      queueRef.current.push(item);
    } else {
      setSending(true);
      void dispatch(item);
    }
  }, [dispatch, draft, phoneAccess, sending]);

  const stop = useCallback(() => {
    // Remove every queued follow-up before signalling the active bridge run.
    const cancelledIds = queueRef.current.map((q) => q.userMessageId);
    queueRef.current = [];
    if (cancelledIds.length > 0) {
      setMessages((m) => m.filter((msg) => !cancelledIds.includes(msg.id)));
    }
    if (activeDispatchRef.current) {
      const activeDispatch = activeDispatchRef.current;
      stoppedDispatchIdsRef.current.add(activeDispatch.dispatchId);
      activeDispatch.abort.abort();
      setMessages((m) =>
        m.map((msg) =>
          msg.id === activeDispatch.replyId
            ? { ...msg, text: msg.text, stopped: true }
            : msg,
        ),
      );
      activeDispatchRef.current = null;
    }
    setSending(false);
  }, []);

  const dictationHeaders = useMemo(() => undefined, []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        unpairedSurface: {
          alignItems: "center",
          flex: 1,
          justifyContent: "center",
          paddingHorizontal: 24,
        },
        block: {
          alignItems: "center",
          gap: 8,
          marginTop: 96,
        },
        title: {
          color: colors.textMuted,
          fontFamily: fonts.display.regularItalic,
          fontSize: 22,
          letterSpacing: -0.5,
          opacity: 0.7,
          textAlign: "center",
        },
        body: {
          color: colors.textMuted,
          fontFamily: fonts.sans.regular,
          fontSize: 15,
          letterSpacing: -0.2,
          lineHeight: 22,
          maxWidth: 280,
          textAlign: "center",
          marginTop: 8,
        },
        connectButton: {
          alignItems: "center",
          backgroundColor: colors.accent,
          borderRadius: 22,
          justifyContent: "center",
          marginTop: 16,
          minHeight: 44,
          paddingHorizontal: 28,
          paddingVertical: 12,
        },
        connectButtonPressed: {
          opacity: 0.85,
        },
        connectButtonText: {
          color: colors.accentForeground,
          fontFamily: fonts.sans.semiBold,
          fontSize: 15,
          letterSpacing: -0.3,
        },
        syncSurface: {
          flex: 1,
        },
        // Spinner overlay shown while we wait for the desktop's current
        // chat snapshot. Floats centered above the chat so the existing
        // transcript (if any) stays visible behind it — replaces, doesn't
        // hide.
        syncOverlay: {
          alignItems: "center",
          bottom: 0,
          justifyContent: "center",
          left: 0,
          pointerEvents: "none",
          position: "absolute",
          right: 0,
          top: 0,
        },
      }),
    [colors],
  );

  const emptyContent = useMemo(
    () => (
      <View style={styles.block}>
        <ConnectHeroAnimation />
        <Text style={styles.title}>Your computer, at your fingertips</Text>
        <Text style={styles.body}>
          Ask Stella to do things on your computer — browse the web, manage
          files, run tasks, and more.
        </Text>
      </View>
    ),
    [styles],
  );

  // Unpaired: take over the entire surface with the pair CTA. We
  // deliberately do not render `ChatPane` here — `loadComputerChatMessages`
  // can rehydrate prior conversations from AsyncStorage, and we don't
  // want a stale chat hiding the connect surface.
  if (paired === false) {
    return (
      <View style={styles.unpairedSurface}>
        <View style={styles.block}>
          <ConnectHeroAnimation />
          <Text style={styles.title}>Pair your phone first</Text>
          <Text style={styles.body}>
            Pair this phone with your Stella desktop so you can chat with it
            from anywhere. You only need to do it once.
          </Text>
          <Pressable
            onPress={() => setPairSheetOpen(true)}
            accessibilityLabel="Pair this phone"
            style={({ pressed }) => [
              styles.connectButton,
              pressed && styles.connectButtonPressed,
            ]}
          >
            <Text style={styles.connectButtonText}>Pair phone</Text>
          </Pressable>
        </View>
        <PairPhoneSheet
          visible={pairSheetOpen}
          onClose={() => setPairSheetOpen(false)}
          onPaired={(access) => {
            setPhoneAccess(access);
            setPaired(true);
            setPairSheetOpen(false);
          }}
        />
      </View>
    );
  }

  const canSubmit =
    draft.trim().length > 0 && paired === true && Boolean(phoneAccess);

  return (
    <View style={styles.syncSurface}>
      <ChatPane
        messages={messages}
        streaming={sending}
        emptyContent={emptyContent}
        historyLoading={!storageLoaded || paired === null}
        draft={draft}
        onChangeDraft={setDraft}
        canSubmit={canSubmit}
        onSubmit={send}
        onStop={stop}
        placeholder="Ask Stella to do something"
        composerEnabled
        enableAttachments={false}
        onViewComputer={() => router.push("/stella")}
        selectedModelLabel={modelSettings.selectedModelLabel}
        onOpenModelSettings={() => setModelSheetOpen(true)}
        dictationAnonymous={false}
        dictationHeaders={dictationHeaders}
      />
      {syncing ? (
        <View style={styles.syncOverlay}>
          <ActivityIndicator size="small" color={colors.textMuted} />
        </View>
      ) : null}
      <ComputerSettingsSheet
        visible={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        access={phoneAccess}
        catalog={modelSettings.catalog}
        onApplied={modelSettings.syncFromSnapshot}
      />
    </View>
  );
}
