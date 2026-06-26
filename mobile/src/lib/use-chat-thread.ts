import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutAnimation } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  loadChatMessages,
  saveChatMessages,
  loadChatSyncState,
  saveChatSyncState,
  type ChatThreadId,
} from "./offline-chat-storage";
import { postStream, postStreamAnonymous, StreamAbortError } from "./http";
import { hasAiConsent, requestAiConsent } from "./ai-consent";
import { getOrCreateMobileDeviceId, type StoredPhoneAccess } from "./phone-access";
import {
  DesktopOfflineError,
  sendDesktopBridgeChat,
  syncDesktopBridgeChatMessages,
  type DesktopBridgeAttachment,
  type DesktopBridgeSendStatus,
} from "./desktop-bridge-chat";
import { mergeMessagesById, reconcileSentDesktopTurn } from "./chat-merge";
import { createStreamTextSmoother } from "./stream-text-smoother";
import { userFacingError } from "./user-facing-error";
import { notifySuccess } from "./haptics";
import type { ChatArtifact, ChatMessage } from "../types";

/** Cap on how many desktop messages we pull per sync. */
const HISTORY_MESSAGE_LIMIT = 100;
/** Cap on how many recent artifacts the Artifacts list sheet shows. */
const MAX_LISTED_ARTIFACTS = 20;

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

/**
 * Where a thread's turns go. `cloud` streams from the offline responder;
 * `desktop` routes to the paired computer's Stella agent over the bridge and
 * keeps the transcript in sync with the canonical desktop rows.
 */
export type ChatTransport =
  | { kind: "cloud"; guest: boolean }
  | { kind: "desktop"; access: StoredPhoneAccess };

export type ChatThread = {
  messages: ChatMessage[];
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  attachments: ImagePicker.ImagePickerAsset[];
  setAttachments: React.Dispatch<
    React.SetStateAction<ImagePicker.ImagePickerAsset[]>
  >;
  sending: boolean;
  workingStatus: string | undefined;
  storageLoaded: boolean;
  /** Recent artifacts in the conversation, newest first and de-duplicated. */
  conversationArtifacts: ChatArtifact[];
  send: () => void;
  stop: () => void;
};

/**
 * Owns a single chat transcript end-to-end: persistence (keyed per thread),
 * the optimistic send queue, streaming, stop, and — for the desktop transport
 * — sync/reconcile against the canonical desktop rows. Routing is fixed by
 * `transport`, so each surface (cloud Chat tab, computer Computer tab) gets a
 * coherent, single-destination conversation with no cross-routing.
 */
export function useChatThread(opts: {
  threadId: ChatThreadId;
  transport: ChatTransport;
}): ChatThread {
  const { threadId, transport } = opts;
  const isDesktop = transport.kind === "desktop";

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);
  const [sending, setSending] = useState(false);
  const [workingStatus, setWorkingStatus] = useState<string | undefined>();

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
  const didMountSyncRef = useRef(false);
  const drainQueueRef = useRef<(() => void) | null>(null);
  // The dispatch fn closes over `transport`; keep the latest in a ref so the
  // stable queue/drain machinery never dispatches against a stale destination.
  const dispatchRef = useRef<((item: QueuedSend) => Promise<void>) | null>(
    null,
  );

  // ─── Hydration & persistence ─────────────────────────────────────────────
  useEffect(() => {
    void Promise.all([
      loadChatMessages(threadId),
      loadChatSyncState(threadId),
    ]).then(([loaded, syncState]) => {
      syncConversationIdRef.current = syncState.conversationId;
      syncCursorRef.current = syncState.cursor;
      setMessages(loaded);
      setStorageLoaded(true);
    });
  }, [threadId]);

  // Debounce persistence so streaming (which mutates `messages` many times a
  // second) doesn't rewrite the whole history to disk on every chunk.
  useEffect(() => {
    if (!storageLoaded) return;
    const handle = setTimeout(() => {
      void saveChatMessages(threadId, messages);
    }, 500);
    return () => clearTimeout(handle);
  }, [messages, storageLoaded, threadId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const persistSyncState = useCallback(
    (state: { conversationId?: string | null; cursor?: string | null }) => {
      const conversationId = state.conversationId?.trim() || null;
      const cursor = state.cursor?.trim() || null;
      syncConversationIdRef.current = conversationId;
      syncCursorRef.current = cursor;
      void saveChatSyncState(threadId, { conversationId, cursor });
    },
    [threadId],
  );

  // ─── Desktop transcript sync ─────────────────────────────────────────────
  // Once per surface landing (when idle), pull new desktop turns and merge
  // them in. Merge-only: locally-streamed rows are never dropped.
  const desktopAccess = isDesktop ? transport.access : null;
  useEffect(() => {
    if (!desktopAccess) return;
    if (didMountSyncRef.current) return;
    if (!storageLoaded) return;
    if (sending) return;

    didMountSyncRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const expectedConversationId = syncConversationIdRef.current;
        const sinceCursor = syncCursorRef.current;
        const next = await syncDesktopBridgeChatMessages({
          access: desktopAccess,
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
      } catch {
        // Best-effort: the device-status poll drives the connection badge, and
        // the next landing retries the sync.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [desktopAccess, persistSyncState, sending, storageLoaded]);

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
    async (item: QueuedSend, replyId: string, abort: AbortController) => {
      const guest = transport.kind === "cloud" ? transport.guest : false;
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
    [appendAssistantText, finishDispatch, transport],
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
              m.map((msg) => (msg.id === replyId ? { ...msg, artifacts } : msg)),
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
          });
        notifySuccess();
        finishDispatch();
      } catch (e) {
        textSmoother.cancel();
        activeDispatchRef.current = null;
        if (stoppedDispatchIdsRef.current.has(item.dispatchId)) {
          setSending(false);
          return;
        }
        // Deterministic routing: the computer thread never silently falls back
        // to the cloud. Surface an offline reply the user can act on (wake the
        // computer and retry).
        const message =
          e instanceof DesktopOfflineError && !sawDelta
            ? "Your computer is offline. Wake it from the menu, then try again."
            : userFacingError(e);
        setWorkingStatus(undefined);
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
    [appendAssistantText, finishDispatch, persistSyncState],
  );

  // ─── Queue & dispatch ─────────────────────────────────────────────────────
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

      if (transport.kind === "desktop") {
        await dispatchDesktop(item, replyId, abort, transport.access);
      } else {
        await dispatchCloud(item, replyId, abort);
      }
    },
    [dispatchCloud, dispatchDesktop, transport],
  );

  useEffect(() => {
    dispatchRef.current = dispatch;
  }, [dispatch]);

  const drainQueue = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) return;
    setSending(true);
    void dispatchRef.current?.(next);
  }, []);

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

  return {
    messages,
    draft,
    setDraft,
    attachments,
    setAttachments,
    sending,
    workingStatus,
    storageLoaded,
    conversationArtifacts,
    send,
    stop,
  };
}
