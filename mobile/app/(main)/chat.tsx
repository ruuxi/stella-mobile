import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutAnimation, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import {
  loadChatMessages,
  saveChatMessages,
  loadChatSyncState,
  saveChatSyncState,
} from "../../src/lib/offline-chat-storage";
import { postStream, postStreamAnonymous, StreamAbortError } from "../../src/lib/http";
import { hasAiConsent, requestAiConsent } from "../../src/lib/ai-consent";
import { isGuest } from "../../src/lib/guest-mode";
import {
  getPreferredPhoneAccess,
  getOrCreateMobileDeviceId,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import {
  DesktopOfflineError,
  sendDesktopBridgeChat,
  syncDesktopBridgeChatMessages,
  type DesktopBridgeAttachment,
  type DesktopBridgeSendStatus,
} from "../../src/lib/desktop-bridge-chat";
import {
  mergeMessagesById,
  reconcileSentDesktopTurn,
} from "../../src/lib/chat-merge";
import {
  consumePendingShare,
  subscribePendingShare,
} from "../../src/lib/pending-share";
import { createStreamTextSmoother } from "../../src/lib/stream-text-smoother";
import { userFacingError } from "../../src/lib/user-facing-error";
import { notifySuccess } from "../../src/lib/haptics";
import { useComputerModelSettings } from "../../src/lib/use-computer-model-settings";
import { useIsOffline } from "../../src/lib/use-network-status";
import {
  useTopBarStatus,
  type DesktopConnection,
} from "../../src/lib/top-bar-status";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import type { ChatArtifact, ChatMessage } from "../../src/types";
import { ChatPane } from "../../src/components/ChatPane";
import { ArtifactViewer } from "../../src/components/ArtifactViewer";
import { ArtifactListSheet } from "../../src/components/ArtifactListSheet";
import { ComputerSettingsSheet } from "../../src/components/ComputerSettingsSheet";

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Cap on how many desktop messages we pull per sync. */
const HISTORY_MESSAGE_LIMIT = 100;
/** Cap on how many recent artifacts the Artifacts list sheet shows. */
const MAX_LISTED_ARTIFACTS = 20;

/**
 * A locally-queued send. When the user submits while a reply is still
 * streaming, we eagerly add the user bubble (marked `queued: true`) and park
 * the dispatch payload here. As soon as the current stream finishes (or is
 * stopped), we drain the next queued item and dispatch it for real.
 */
type QueuedSend = {
  dispatchId: string;
  userMessageId: string;
  text: string;
  assets: ImagePicker.ImagePickerAsset[];
};

const WAKE_STATUS_COPY: Record<DesktopBridgeSendStatus, string | undefined> = {
  connecting: "Reaching your computer",
  waking: "Waking your computer",
  running: undefined,
};

const assetsToBridgeAttachments = (
  assets: ImagePicker.ImagePickerAsset[],
): DesktopBridgeAttachment[] | null => {
  const out: DesktopBridgeAttachment[] = [];
  for (const asset of assets) {
    if (!asset.base64) return null;
    const mimeType = asset.mimeType ?? "image/jpeg";
    out.push({ url: `data:${mimeType};base64,${asset.base64}`, mimeType });
  }
  return out;
};

/**
 * The one chat. Messages route to the paired desktop's Stella agent when the
 * phone is paired (waking the computer if needed), and to the cloud when it
 * isn't — the transcript stays a single continuous conversation either way.
 */
export default function ChatScreen() {
  const colors = useColors();
  const router = useRouter();
  const guest = isGuest();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);
  const [sending, setSending] = useState(false);
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);
  const [phoneAccess, setPhoneAccess] = useState<StoredPhoneAccess | null>(
    null,
  );
  const [paired, setPaired] = useState<boolean | null>(null);
  // Status line shown beside the working creature while we reach/wake the
  // desktop. Cleared once the run starts (default reasoning copy takes over).
  const [workingStatus, setWorkingStatus] = useState<string | undefined>();
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(
    null,
  );
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  // Desktop reachability for the top-bar indicator. `inFlight` covers any
  // bridge activity (spinner); `lastOk` records the last outcome (dot).
  const [inFlight, setInFlight] = useState(false);
  const [lastOk, setLastOk] = useState<boolean | null>(null);

  const offline = useIsOffline();
  const { setConnection: setTopBarConnection } = useTopBarStatus();
  const modelSettings = useComputerModelSettings();

  const queueRef = useRef<QueuedSend[]>([]);
  const stoppedDispatchIdsRef = useRef<Set<string>>(new Set());
  const activeDispatchRef = useRef<{
    dispatchId: string;
    replyId: string;
    abort: AbortController;
  } | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const syncCursorRef = useRef<string | null>(null);
  const syncConversationIdRef = useRef<string | null>(null);
  const syncActivityCountRef = useRef(0);
  const didMountSyncRef = useRef(false);
  const drainQueueRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!guest) return;
    void getOrCreateMobileDeviceId().then(setMobileDeviceId);
  }, [guest]);

  useEffect(() => {
    if (guest) {
      setPhoneAccess(null);
      setPaired(false);
      return;
    }
    void getPreferredPhoneAccess().then((access) => {
      setPhoneAccess(access);
      setPaired(Boolean(access));
    });
  }, [guest]);

  useEffect(() => {
    void Promise.all([loadChatMessages(), loadChatSyncState()]).then(
      ([loaded, syncState]) => {
        syncConversationIdRef.current = syncState.conversationId;
        syncCursorRef.current = syncState.cursor;
        setMessages(loaded);
        setStorageLoaded(true);
      },
    );
  }, []);

  // Debounce persistence so streaming (which mutates `messages` many times a
  // second) doesn't rewrite the whole history to disk on every chunk.
  useEffect(() => {
    if (!storageLoaded) return;
    const handle = setTimeout(() => {
      void saveChatMessages(messages);
    }, 500);
    return () => clearTimeout(handle);
  }, [messages, storageLoaded]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Content shared in from another app prefills the composer (it never
  // auto-sends — the user confirms with the send button).
  useEffect(() => {
    const applyShare = () => {
      const share = consumePendingShare();
      if (!share) return;
      if (share.text) {
        setDraft((prev) =>
          prev.trim() ? `${prev.trimEnd()} ${share.text}` : share.text ?? "",
        );
      }
      if (share.assets?.length) {
        setAttachments((prev) => [...prev, ...share.assets!]);
      }
    };
    applyShare();
    return subscribePendingShare(applyShare);
  }, []);

  const persistSyncState = useCallback(
    (state: { conversationId?: string | null; cursor?: string | null }) => {
      const conversationId = state.conversationId?.trim() || null;
      const cursor = state.cursor?.trim() || null;
      syncConversationIdRef.current = conversationId;
      syncCursorRef.current = cursor;
      void saveChatSyncState({ conversationId, cursor });
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

  // Top-bar indicator: only meaningful while paired — the cloud route needs
  // no connection affordance.
  const connection: DesktopConnection | null = !paired
    ? null
    : inFlight || lastOk === null
      ? "connecting"
      : lastOk
        ? "connected"
        : "disconnected";

  useEffect(() => {
    setTopBarConnection(connection);
  }, [connection, setTopBarConnection]);

  useEffect(() => () => setTopBarConnection(null), [setTopBarConnection]);

  // ─── Desktop transcript sync ─────────────────────────────────────────────
  // Once per tab landing (when paired and idle), pull new desktop turns and
  // merge them into the unified transcript. Merge-only: cloud-answered rows
  // are never dropped.
  useEffect(() => {
    if (didMountSyncRef.current) return;
    if (!storageLoaded) return;
    if (paired !== true || !phoneAccess) return;
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
        setMessages((current) => mergeMessagesById(current, next.messages));
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

  const appendAssistantText = useCallback((replyId: string, chunk: string) => {
    setMessages((m) =>
      m.map((msg) =>
        msg.id === replyId ? { ...msg, text: msg.text + chunk } : msg,
      ),
    );
  }, []);

  const finishDispatch = useCallback(() => {
    setSending(false);
    setWorkingStatus(undefined);
    drainQueueRef.current?.();
  }, []);

  // ─── Cloud dispatch ───────────────────────────────────────────────────────
  const dispatchCloud = useCallback(
    async (
      item: QueuedSend,
      replyId: string,
      abort: AbortController,
      cloudFallback: boolean,
    ) => {
      const queuedIds = new Set(queueRef.current.map((q) => q.userMessageId));
      const history = messagesRef.current
        .filter(
          (m) =>
            m.id !== item.userMessageId &&
            m.id !== replyId &&
            !queuedIds.has(m.id) &&
            !m.queued,
        )
        .map((m) => ({ role: m.role, text: m.text }))
        .filter((m) => m.text.trim().length > 0);

      const imagesPayload: { base64: string; mimeType: string }[] = [];
      for (const a of item.assets) {
        if (!a.base64) continue;
        imagesPayload.push({
          base64: a.base64,
          mimeType: a.mimeType ?? "image/jpeg",
        });
      }

      const textSmoother = createStreamTextSmoother({
        appendText: (chunk) => appendAssistantText(replyId, chunk),
      });

      const ensureFallbackReply = () => {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId && !msg.text
              ? { ...msg, text: "No reply came back. Try again." }
              : msg,
          ),
        );
      };

      if (cloudFallback) {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId ? { ...msg, cloudFallback: true } : msg,
          ),
        );
      }

      const streamFn = guest ? postStreamAnonymous : postStream;
      const streamOptions = {
        signal: abort.signal,
        ...(guest
          ? {
              headers: {
                "X-Stella-Mobile-Device-Id": await getOrCreateMobileDeviceId(),
              },
            }
          : {}),
      };

      try {
        await streamFn(
          "/api/mobile/offline-chat/stream",
          {
            message: item.text,
            history,
            images: imagesPayload,
          },
          (delta) => textSmoother.push(delta),
          streamOptions,
        );
        await textSmoother.drain();
        ensureFallbackReply();
        notifySuccess();
      } catch (e) {
        if (e instanceof StreamAbortError) {
          textSmoother.cancel();
          setMessages((m) =>
            m.map((msg) =>
              msg.id === replyId ? { ...msg, stopped: true } : msg,
            ),
          );
        } else {
          textSmoother.flushNow();
          setMessages((m) =>
            m.map((msg) =>
              msg.id === replyId
                ? { ...msg, text: msg.text || userFacingError(e) }
                : msg,
            ),
          );
        }
      } finally {
        textSmoother.cancel();
        if (activeDispatchRef.current?.replyId === replyId) {
          activeDispatchRef.current = null;
        }
        finishDispatch();
      }
    },
    [appendAssistantText, finishDispatch, guest],
  );

  // ─── Desktop dispatch ─────────────────────────────────────────────────────
  const dispatchDesktop = useCallback(
    async (
      item: QueuedSend,
      replyId: string,
      abort: AbortController,
      access: StoredPhoneAccess,
    ) => {
      const textSmoother = createStreamTextSmoother({
        appendText: (chunk) => appendAssistantText(replyId, chunk),
      });
      let sawDelta = false;

      try {
        const result = await sendDesktopBridgeChat({
          access,
          message: item.text,
          attachments: assetsToBridgeAttachments(item.assets) ?? undefined,
          signal: abort.signal,
          onStatus: (status) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            setWorkingStatus(WAKE_STATUS_COPY[status]);
          },
          onTextDelta: (delta) => {
            if (stoppedDispatchIdsRef.current.has(item.dispatchId)) return;
            sawDelta = true;
            setWorkingStatus(undefined);
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
        // Reconcile with canonical desktop rows in the background so ids line
        // up with future syncs.
        const endSyncIndicator = beginSyncIndicator();
        void syncDesktopBridgeChatMessages({
          access,
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
            const hasCanonicalAssistant = delta.messages.some(
              (message) => message.role === "assistant",
            );
            if (!hasCanonicalAssistant) return;
            setMessages((m) =>
              reconcileSentDesktopTurn({
                current: m,
                userMessageId: item.userMessageId,
                replyId,
                sentText: item.text,
                canonicalMessages: delta.messages,
              }),
            );
          })
          .catch(() => {
            // The optimistic local turn is already rendered; the next sync
            // will reconcile with canonical desktop message ids.
          })
          .finally(endSyncIndicator);
        notifySuccess();
        finishDispatch();
      } catch (e) {
        textSmoother.cancel();
        activeDispatchRef.current = null;
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          setSending(false);
          return;
        }
        // The desktop never came online and nothing streamed — answer from
        // the cloud instead so the user is never left hanging.
        if (e instanceof DesktopOfflineError && !sawDelta) {
          setLastOk(false);
          setWorkingStatus(undefined);
          const fallbackAbort = new AbortController();
          activeDispatchRef.current = {
            dispatchId: item.dispatchId,
            replyId,
            abort: fallbackAbort,
          };
          await dispatchCloud(item, replyId, fallbackAbort, true);
          return;
        }
        setLastOk(false);
        const message = userFacingError(e);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId ? { ...msg, text: msg.text || message } : msg,
          ),
        );
        finishDispatch();
      } finally {
        textSmoother.cancel();
      }
    },
    [
      appendAssistantText,
      beginSyncIndicator,
      dispatchCloud,
      finishDispatch,
      persistSyncState,
    ],
  );

  const dispatch = useCallback(
    async (item: QueuedSend) => {
      const replyId = createId();
      const abort = new AbortController();
      activeDispatchRef.current = {
        dispatchId: item.dispatchId,
        replyId,
        abort,
      };
      // Promote the queued bubble out of the dimmed state and add an empty
      // assistant placeholder beside it.
      setMessages((m) => [
        ...m.map((msg) =>
          msg.id === item.userMessageId ? { ...msg, queued: false } : msg,
        ),
        { id: replyId, role: "assistant" as const, text: "" },
      ]);

      if (paired && phoneAccess) {
        await dispatchDesktop(item, replyId, abort, phoneAccess);
      } else {
        await dispatchCloud(item, replyId, abort, false);
      }
    },
    [dispatchCloud, dispatchDesktop, paired, phoneAccess],
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
    if (!text && attachments.length === 0) return;

    if (!hasAiConsent()) {
      requestAiConsent();
      return;
    }

    const assets = attachments.slice();
    setDraft("");
    setAttachments([]);

    const userMessageId = createId();
    const displayText = text || (assets.length ? "Photo" : "");
    const thumbs = assets.slice(0, 3).map((a) => a.uri);
    const userMsg: ChatMessage = {
      id: userMessageId,
      role: "user",
      text: displayText,
      hasImage: assets.length > 0,
      ...(thumbs.length > 0 ? { thumbnailUris: thumbs } : {}),
      ...(sending ? { queued: true } : {}),
    };

    LayoutAnimation.configureNext({
      duration: 350,
      update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
    });
    setMessages((m) => [...m, userMsg]);

    const item: QueuedSend = {
      dispatchId: createId(),
      userMessageId,
      text,
      assets,
    };
    if (sending) {
      queueRef.current.push(item);
    } else {
      setSending(true);
      void dispatch(item);
    }
  }, [attachments, dispatch, draft, sending]);

  const stop = useCallback(() => {
    // Drop queued follow-ups first so the in-flight finally-handler doesn't
    // pick them up after the abort.
    const cancelledIds = queueRef.current.map((q) => q.userMessageId);
    queueRef.current = [];
    if (cancelledIds.length > 0) {
      setMessages((m) => m.filter((msg) => !cancelledIds.includes(msg.id)));
    }
    if (activeDispatchRef.current) {
      const active = activeDispatchRef.current;
      stoppedDispatchIdsRef.current.add(active.dispatchId);
      active.abort.abort();
      setMessages((m) =>
        m.map((msg) =>
          msg.id === active.replyId ? { ...msg, stopped: true } : msg,
        ),
      );
      activeDispatchRef.current = null;
    }
    setSending(false);
    setWorkingStatus(undefined);
  }, []);

  const dictationHeaders = useMemo(() => {
    if (!guest || !mobileDeviceId) return undefined;
    return { "X-Stella-Mobile-Device-Id": mobileDeviceId };
  }, [guest, mobileDeviceId]);

  // Recent artifacts in the conversation, newest first and de-duplicated.
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

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1 },
        emptyText: {
          color: colors.textMuted,
          fontFamily: fonts.display.regularItalic,
          fontSize: 22,
          letterSpacing: -0.5,
          opacity: 0.45,
        },
      }),
    [colors],
  );

  const canSubmit =
    (draft.trim().length > 0 || attachments.length > 0) && !offline;

  return (
    <View style={styles.root}>
      <ChatPane
        messages={messages}
        streaming={sending}
        workingStatus={workingStatus}
        emptyContent={<Text style={styles.emptyText}>Ask Stella anything</Text>}
        historyLoading={!storageLoaded || paired === null}
        draft={draft}
        onChangeDraft={setDraft}
        canSubmit={canSubmit}
        onSubmit={send}
        onStop={stop}
        placeholder="Message Stella"
        offline={offline}
        enableAttachments
        attachments={attachments}
        onChangeAttachments={setAttachments}
        dictationAnonymous={guest}
        dictationHeaders={dictationHeaders}
        {...(paired
          ? {
              onViewComputer: () => router.push("/stella"),
              selectedModelLabel: modelSettings.selectedModelLabel,
              onOpenModelSettings: () => setModelSheetOpen(true),
              onOpenArtifact: setSelectedArtifact,
              onOpenArtifacts: () => setArtifactsOpen(true),
            }
          : {})}
      />
      {paired ? (
        <>
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
        </>
      ) : null}
    </View>
  );
}
