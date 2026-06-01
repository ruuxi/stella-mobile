import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import {
  loadComputerChatSyncState,
  loadComputerChatMessages,
  saveComputerChatSyncState,
  saveComputerChatMessages,
} from "../../src/lib/offline-chat-storage";
import { isGuest } from "../../src/lib/guest-mode";
import { SignInPrompt } from "../../src/components/SignInPrompt";
import {
  getPreferredPhoneAccess,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import {
  normalizeDesktopChatMessageText,
  sendDesktopBridgeChat,
  syncDesktopBridgeChatMessages,
} from "../../src/lib/desktop-bridge-chat";
import { createStreamTextSmoother } from "../../src/lib/stream-text-smoother";
import { userFacingError } from "../../src/lib/user-facing-error";
import { notifySuccess } from "../../src/lib/haptics";
import { useComputerModelSettings } from "../../src/lib/use-computer-model-settings";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import type { ChatArtifact, ChatMessage } from "../../src/types";
import { ChatPane } from "../../src/components/ChatPane";
import { ArtifactViewer } from "../../src/components/ArtifactViewer";
import { ArtifactListSheet } from "../../src/components/ArtifactListSheet";
import { ComputerSettingsSheet } from "../../src/components/ComputerSettingsSheet";
import { ConnectHeroAnimation } from "../../src/components/ConnectHeroAnimation";
import { PairPhoneSheet } from "../../src/components/PairPhoneSheet";
import {
  useTopBarStatus,
  type DesktopConnection,
} from "../../src/lib/top-bar-status";

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const mergeMessagesById = (
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] => {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  const order = current.map((message) => message.id);
  for (const message of incoming) {
    if (!byId.has(message.id)) {
      order.push(message.id);
    }
    byId.set(message.id, message);
  }
  return order
    .map((id) => byId.get(id))
    .filter((message): message is ChatMessage => Boolean(message));
};

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

/** Cap on how many recent artifacts the Artifacts list sheet shows. */
const MAX_LISTED_ARTIFACTS = 20;

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
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(
    null,
  );
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  // Desktop connection state surfaced in the top-bar center. `inFlight` is true
  // while any sync/connection attempt runs (→ spinner); `lastOk` records the
  // last attempt's outcome (→ green/red dot once idle).
  const [inFlight, setInFlight] = useState(false);
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  // One-shot desktop history sync guard so the sync runs exactly once per tab
  // landing once the bridge preconditions are ready.
  const didMountSyncRef = useRef(false);
  const { setConnection: setTopBarConnection } = useTopBarStatus();
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
  const syncCursorRef = useRef<string | null>(null);
  const syncConversationIdRef = useRef<string | null>(null);
  const syncActivityCountRef = useRef(0);
  // Forward declaration so `dispatch` can call the latest `drainQueue`
  // without depending on its identity (which would create a callback cycle).
  const drainQueueRef = useRef<(() => void) | null>(null);

  const persistSyncState = useCallback(
    (state: { conversationId?: string | null; cursor?: string | null }) => {
      const conversationId = state.conversationId?.trim() || null;
      const cursor = state.cursor?.trim() || null;
      syncConversationIdRef.current = conversationId;
      syncCursorRef.current = cursor;
      void saveComputerChatSyncState({ conversationId, cursor });
    },
    [],
  );

  const beginSyncIndicator = useCallback(() => {
    let ended = false;
    syncActivityCountRef.current += 1;
    setInFlight(true);
    return () => {
      if (ended) return;
      ended = true;
      syncActivityCountRef.current = Math.max(
        0,
        syncActivityCountRef.current - 1,
      );
      if (syncActivityCountRef.current === 0) {
        setInFlight(false);
      }
    };
  }, []);

  // Derive the top-bar connection status from pairing + sync activity and push
  // it up to the shared top bar. Resets to null when leaving the tab so the
  // indicator only shows on the computer chat.
  const connection: DesktopConnection =
    paired === false
      ? "disconnected"
      : inFlight || paired === null || lastOk === null
        ? "connecting"
        : lastOk
          ? "connected"
          : "disconnected";

  useEffect(() => {
    setTopBarConnection(connection);
  }, [connection, setTopBarConnection]);

  useEffect(
    () => () => setTopBarConnection(null),
    [setTopBarConnection],
  );

  useEffect(() => {
    void getPreferredPhoneAccess().then((access) => {
      setPhoneAccess(access);
      setPaired(Boolean(access));
    });
  }, []);

  useEffect(() => {
    void Promise.all([
      loadComputerChatMessages(),
      loadComputerChatSyncState(),
    ]).then(([loaded, syncState]) => {
      const normalizedMessages = loaded
        .map((message) => ({
          ...message,
          text: normalizeDesktopChatMessageText(message.text),
        }))
        .filter(
          (message) =>
            message.text.length > 0 || (message.artifacts?.length ?? 0) > 0,
        );
      const effectiveConversationId =
        normalizedMessages.length > 0 ? syncState.conversationId : null;
      const effectiveCursor =
        normalizedMessages.length > 0 && effectiveConversationId
          ? syncState.cursor
          : null;
      syncConversationIdRef.current = effectiveConversationId;
      syncCursorRef.current = effectiveCursor;
      if (
        effectiveConversationId !== syncState.conversationId ||
        effectiveCursor !== syncState.cursor
      ) {
        void saveComputerChatSyncState({
          conversationId: effectiveConversationId,
          cursor: effectiveCursor,
        });
      }
      setMessages(normalizedMessages);
      setStorageLoaded(true);
    });
  }, []);

  // Debounce persistence so streaming (which mutates `messages` many times a
  // second) doesn't rewrite the whole history to disk on every chunk.
  useEffect(() => {
    if (!storageLoaded) return;
    const handle = setTimeout(() => {
      void saveComputerChatMessages(messages);
    }, 500);
    return () => clearTimeout(handle);
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
    const endSyncIndicator = beginSyncIndicator();
    void (async () => {
      try {
        const expectedConversationId = syncConversationIdRef.current;
        const sinceCursor = syncCursorRef.current;
        const next = await syncDesktopBridgeChatMessages({
          access: phoneAccess,
          expectedConversationId,
          sinceCursor: expectedConversationId ? sinceCursor : null,
          maxMessages: HISTORY_MESSAGE_LIMIT,
        });
        if (cancelled) return;
        persistSyncState({
          conversationId: next.conversationId,
          cursor: next.cursor,
        });
        setMessages((current) =>
          sinceCursor && !next.conversationChanged
            ? mergeMessagesById(current, next.messages)
            : next.messages,
        );
        setLastOk(true);
      } catch {
        if (cancelled) return;
        setLastOk(false);
      } finally {
        if (!cancelled) {
          endSyncIndicator();
        }
      }
    })();

    return () => {
      cancelled = true;
      endSyncIndicator();
    };
  }, [
    beginSyncIndicator,
    paired,
    persistSyncState,
    phoneAccess,
    sending,
    storageLoaded,
  ]);

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

      const textSmoother = createStreamTextSmoother({
        appendText: (chunk) => {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === replyId ? { ...msg, text: msg.text + chunk } : msg,
            ),
          );
        },
      });

      if (!phoneAccess) {
        textSmoother.cancel();
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
          onTextDelta: (delta) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            textSmoother.push(delta);
          },
          onArtifacts: (artifacts) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === replyId ? { ...msg, artifacts } : msg,
              ),
            );
          },
        });
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          activeDispatchRef.current = null;
          setSending(false);
          return;
        }
        await textSmoother.drain();
        activeDispatchRef.current = null;
        setLastOk(true);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId
              ? {
                  ...msg,
                  text: result.text,
                  ...(result.artifacts.length > 0
                    ? { artifacts: result.artifacts }
                    : {}),
                }
              : msg,
          ),
        );
        const endSyncIndicator = beginSyncIndicator();
        void syncDesktopBridgeChatMessages({
          access: phoneAccess,
          expectedConversationId: syncConversationIdRef.current,
          sinceCursor: syncConversationIdRef.current
            ? syncCursorRef.current
            : null,
          maxMessages: HISTORY_MESSAGE_LIMIT,
        })
          .then((delta) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            persistSyncState({
              conversationId: delta.conversationId,
              cursor: delta.cursor,
            });
            if (delta.conversationChanged) {
              if (delta.messages.length > 0) {
                setMessages(delta.messages);
              }
              return;
            }
            const hasCanonicalAssistant = delta.messages.some(
              (message) => message.role === "assistant",
            );
            if (!hasCanonicalAssistant) return;
            setMessages((m) =>
              mergeMessagesById(
                m.filter(
                  (msg) => msg.id !== item.userMessageId && msg.id !== replyId,
                ),
                delta.messages,
              ),
            );
          })
          .catch(() => {
            // The optimistic local turn is already rendered; the next tab sync
            // will reconcile with canonical desktop message ids.
          })
          .finally(endSyncIndicator);
        notifySuccess();
        setSending(false);
        drainQueueRef.current?.();
      } catch (e) {
        activeDispatchRef.current = null;
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          setSending(false);
          return;
        }
        setLastOk(false);
        textSmoother.flushNow();
        const message = userFacingError(e);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId
              ? { ...msg, text: msg.text || message }
              : msg,
          ),
        );
        setSending(false);
        drainQueueRef.current?.();
      } finally {
        textSmoother.cancel();
      }
    },
    [beginSyncIndicator, persistSyncState, phoneAccess],
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

  // The most recent artifacts in the conversation, newest first and
  // de-duplicated, for the Artifacts list sheet. Capped so a long history
  // doesn't grow the list unbounded.
  const conversationArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const out: ChatArtifact[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      for (const artifact of messages[i].artifacts ?? []) {
        if (seen.has(artifact.id)) continue;
        seen.add(artifact.id);
        out.push(artifact);
        if (out.length >= MAX_LISTED_ARTIFACTS) return out;
      }
    }
    return out;
  }, [messages]);

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
    draft.trim().length > 0 &&
    paired === true &&
    Boolean(phoneAccess) &&
    connection === "connected";

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
        onOpenArtifact={setSelectedArtifact}
        onOpenArtifacts={() => setArtifactsOpen(true)}
      />
      <ComputerSettingsSheet
        visible={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        access={phoneAccess}
        catalog={modelSettings.catalog}
        onApplied={modelSettings.syncFromSnapshot}
      />
      <ArtifactListSheet
        visible={artifactsOpen}
        artifacts={conversationArtifacts}
        onClose={() => setArtifactsOpen(false)}
        onSelect={setSelectedArtifact}
      />
      <ArtifactViewer
        visible={Boolean(selectedArtifact)}
        artifact={selectedArtifact}
        access={phoneAccess}
        onClose={() => setSelectedArtifact(null)}
      />
    </View>
  );
}
