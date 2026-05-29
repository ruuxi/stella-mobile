import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutAnimation, StyleSheet, Text, View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  loadOfflineChatMessages,
  saveOfflineChatMessages,
} from "../../src/lib/offline-chat-storage";
import { postStream, postStreamAnonymous, StreamAbortError } from "../../src/lib/http";
import { hasAiConsent, requestAiConsent } from "../../src/lib/ai-consent";
import { isGuest } from "../../src/lib/guest-mode";
import { getOrCreateMobileDeviceId } from "../../src/lib/phone-access";
import { createStreamTextSmoother } from "../../src/lib/stream-text-smoother";
import { userFacingError } from "../../src/lib/user-facing-error";
import { notifySuccess } from "../../src/lib/haptics";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import type { ChatMessage } from "../../src/types";
import { ChatPane } from "../../src/components/ChatPane";

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A locally-queued send. When the user submits while a reply is still
 * streaming, we eagerly add the user bubble (marked `queued: true`) and park
 * the dispatch payload here. As soon as the current stream finishes (or is
 * stopped), we drain the next queued item and dispatch it for real.
 */
type QueuedSend = {
  userMessageId: string;
  text: string;
  assets: ImagePicker.ImagePickerAsset[];
};

export default function ChatScreen() {
  const colors = useColors();
  const guest = isGuest();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);
  const [sending, setSending] = useState(false);
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);

  // Local follow-up queue. Mirrors the desktop's `queuedUserMessages` model
  // (see `desktop/src/app/chat/hooks/use-streaming-chat.ts`): user messages
  // submitted mid-stream stack visually and are dispatched once the
  // in-flight reply settles, instead of racing the streaming response.
  const queueRef = useRef<QueuedSend[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    if (!guest) return;
    void getOrCreateMobileDeviceId().then(setMobileDeviceId);
  }, [guest]);

  useEffect(() => {
    void loadOfflineChatMessages().then((loaded) => {
      setMessages(loaded);
      setStorageLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!storageLoaded) return;
    void saveOfflineChatMessages(messages);
  }, [messages, storageLoaded]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const dictationHeaders = useMemo(() => {
    if (!guest || !mobileDeviceId) return undefined;
    return { "X-Stella-Mobile-Device-Id": mobileDeviceId };
  }, [guest, mobileDeviceId]);

  const canSubmit = draft.trim().length > 0 || attachments.length > 0;

  // ---------------------------------------------------------------------
  // Stream dispatch. Runs the actual HTTP stream for a single queued item.
  // The caller is responsible for adding the user message to `messages`
  // first (with or without `queued: true`) — `dispatch` clears the
  // queued flag, appends the assistant placeholder, and drains the next
  // queued item from `queueRef` on completion.
  // ---------------------------------------------------------------------
  const dispatch = useCallback(
    async (item: QueuedSend) => {
      const controller = new AbortController();
      abortRef.current = controller;

      // Promote the queued user bubble out of the dimmed state now that
      // we're actually sending it.
      setMessages((m) =>
        m.map((msg) =>
          msg.id === item.userMessageId ? { ...msg, queued: false } : msg,
        ),
      );

      // History excludes the current user message (we pass `text` separately)
      // AND any other queued user messages still parked behind this one — the
      // server should only see real, dispatched turns.
      const queuedIds = new Set(queueRef.current.map((q) => q.userMessageId));
      const history = messagesRef.current
        .filter(
          (m) =>
            m.id !== item.userMessageId &&
            !queuedIds.has(m.id) &&
            !m.queued,
        )
        .map((m) => ({ role: m.role, text: m.text }));

      const imagesPayload: { base64: string; mimeType: string }[] = [];
      for (const a of item.assets) {
        if (!a.base64) {
          setMessages((m) => [
            ...m,
            {
              id: createId(),
              role: "assistant",
              text: "Could not read that image. Try choosing it again.",
            },
          ]);
          abortRef.current = null;
          setSending(false);
          void drainQueue();
          return;
        }
        imagesPayload.push({
          base64: a.base64,
          mimeType: a.mimeType ?? "image/jpeg",
        });
      }

      const replyId = createId();
      setMessages((m) => [...m, { id: replyId, role: "assistant", text: "" }]);

      // Reveal provider chunks at a fixed cadence so the visible text grows
      // smoothly even when upstream tokens arrive in uneven bursts.
      const textSmoother = createStreamTextSmoother({
        appendText: (chunk) => {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === replyId ? { ...msg, text: msg.text + chunk } : msg,
            ),
          );
        },
      });
      const onDelta = (delta: string) => {
        textSmoother.push(delta);
      };

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
        signal: controller.signal,
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
          onDelta,
          streamOptions,
        );
        await textSmoother.drain();
        ensureFallbackReply();
        notifySuccess();
      } catch (e) {
        if (e instanceof StreamAbortError) {
          textSmoother.cancel();
          // Stop pressed — mark the reply row as stopped (keep any partial
          // text the user had already seen) and let the queue drain be
          // suppressed by the `stop()` handler that initiated the abort.
          setMessages((m) =>
            m.map((msg) =>
              msg.id === replyId
                ? { ...msg, text: msg.text, stopped: true }
                : msg,
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
        if (abortRef.current === controller) abortRef.current = null;
        setSending(false);
        // Drain the next queued send — but only if the user didn't press
        // Stop (Stop clears `queueRef` synchronously before signalling).
        void drainQueue();
      }
    },
    [guest],
  );

  const drainQueue = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) return;
    setSending(true);
    void dispatch(next);
  }, [dispatch]);

  const enqueueOrDispatch = useCallback(
    (text: string, assets: ImagePicker.ImagePickerAsset[]) => {
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

      const item: QueuedSend = { userMessageId, text, assets };
      if (sending) {
        queueRef.current.push(item);
      } else {
        setSending(true);
        void dispatch(item);
      }
    },
    [dispatch, sending],
  );

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
    enqueueOrDispatch(text, assets);
  }, [attachments, draft, enqueueOrDispatch]);

  const stop = useCallback(() => {
    // Drop any queued items first so the in-flight finally-handler doesn't
    // pick them up after the abort.
    const cancelledIds = queueRef.current.map((q) => q.userMessageId);
    queueRef.current = [];
    if (cancelledIds.length > 0) {
      setMessages((m) => m.filter((msg) => !cancelledIds.includes(msg.id)));
    }
    abortRef.current?.abort();
  }, []);

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

  return (
    <View style={styles.root}>
      <ChatPane
        messages={messages}
        streaming={sending}
        emptyContent={<Text style={styles.emptyText}>Ask Stella anything</Text>}
        historyLoading={!storageLoaded}
        draft={draft}
        onChangeDraft={setDraft}
        canSubmit={canSubmit}
        onSubmit={send}
        onStop={stop}
        placeholder="Message Stella"
        enableAttachments
        attachments={attachments}
        onChangeAttachments={setAttachments}
        dictationAnonymous={guest}
        dictationHeaders={dictationHeaders}
      />
    </View>
  );
}
