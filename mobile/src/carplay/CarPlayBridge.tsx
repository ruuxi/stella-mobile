/**
 * Headless bridge between CarPlay's imperative templates and Stella's existing
 * mobile plumbing. It mounts once (inside the auth/Convex providers, so tokens
 * resolve) and stays mounted for the app's lifetime, but renders nothing.
 *
 * It deliberately reuses — never re-implements — the app's pipelines:
 *   • send + response  → {@link useChatThread} on the cloud transport (the same
 *     `/api/mobile/offline-chat/stream` flow the Chat tab uses), on a dedicated
 *     "carplay" transcript so it never races the Chat tab's "cloud" store.
 *   • dictation        → {@link useDictation} (the same `/api/mobile/transcribe`
 *     push-to-talk recorder the composer mic uses).
 *   • text-to-speech   → {@link speakReply} from read-aloud (the same Inworld
 *     TTS the chat "read aloud" button uses), so replies sound identical.
 *
 * The hands-free loop: tap → record → stop → transcribe → send → await reply →
 * auto-speak it → offer one-tap replay. {@link carPlaySession} owns the actual
 * CarPlay templates; this component just drives its phases.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { isGuest } from "../lib/guest-mode";
import { getOrCreateMobileDeviceId } from "../lib/phone-access";
import { useChatThread } from "../lib/use-chat-thread";
import { useDictation } from "../lib/dictation";
import { speakReply, stopReadAloud, useReadAloudState } from "../lib/read-aloud";
import { carPlaySession, type CarPlayPhase } from "./carplay-session";

export function CarPlayBridge() {
  // CarPlay is iOS-only; `Platform.OS` is constant at runtime, so this gate is
  // stable and never changes the hook order below.
  if (Platform.OS !== "ios") return null;
  return <CarPlayBridgeIOS />;
}

function CarPlayBridgeIOS() {
  const guest = isGuest();
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);

  const transport = useMemo(
    () => ({ kind: "cloud" as const, guest }),
    [guest],
  );
  const thread = useChatThread({ threadId: "carplay", transport });
  const { setDraft, send, messages, sending, storageLoaded } = thread;

  const readAloud = useReadAloudState();

  // The transcript text we're waiting to dispatch once the draft state catches
  // up, plus flags tracking the in-flight turn and the last spoken reply.
  const pendingSendRef = useRef<string | null>(null);
  const awaitingReplyRef = useRef(false);
  const prevSendingRef = useRef(false);
  const lastReplyTextRef = useRef("");
  const phaseRef = useRef<CarPlayPhase>("idle");

  // Single entry point for phase changes so we keep a local mirror (the session
  // is imperative and doesn't expose its phase back to React).
  const goPhase = useCallback((phase: CarPlayPhase) => {
    phaseRef.current = phase;
    carPlaySession.setPhase(phase);
  }, []);

  useEffect(() => {
    if (!guest) return;
    void getOrCreateMobileDeviceId().then(setMobileDeviceId);
  }, [guest]);

  const dictationHeaders = useMemo(() => {
    if (!guest || !mobileDeviceId) return undefined;
    return { "X-Stella-Mobile-Device-Id": mobileDeviceId };
  }, [guest, mobileDeviceId]);

  const onTranscript = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        goPhase("idle");
        return;
      }
      // Park the transcript and prime the composer draft; the effect below
      // dispatches it through the real send pipeline once the draft settles.
      pendingSendRef.current = trimmed;
      goPhase("thinking");
      setDraft(trimmed);
    },
    [goPhase, setDraft],
  );

  const dictation = useDictation({
    anonymous: guest,
    headers: dictationHeaders,
    onTranscript,
  });

  // Tap-to-talk toggle from the CarPlay home row / replay card.
  const onTalk = useCallback(() => {
    if (dictation.status === "idle") {
      goPhase("listening");
      // If recording never actually begins (AI consent not yet granted, mic
      // permission denied, or the recorder failed to start) the dictation
      // status stays "idle" — so the status-driven safety net below never
      // re-fires and would strand the listening overlay on the head unit.
      // Reconcile straight off the start() result instead.
      void dictation.start().then((started) => {
        if (!started && phaseRef.current === "listening") goPhase("idle");
      });
    } else if (dictation.status === "recording") {
      goPhase("thinking");
      void dictation.stop();
    }
    // While transcribing/thinking, ignore taps — the loop is mid-flight.
  }, [dictation, goPhase]);

  // One-tap replay of the last spoken reply (road noise insurance).
  const onReplay = useCallback(() => {
    const text = lastReplyTextRef.current;
    if (text) void speakReply(text);
  }, []);

  // Keep the session bound to the latest closures.
  useEffect(() => {
    carPlaySession.bindActions({ onTalk, onReplay });
  }, [onTalk, onReplay]);

  useEffect(() => {
    carPlaySession.register();
  }, []);

  // Dispatch the parked transcript once the draft state reflects it.
  useEffect(() => {
    const pending = pendingSendRef.current;
    if (!pending) return;
    if (!storageLoaded) return;
    if (thread.draft.trim() !== pending) return;
    if (sending) return;
    pendingSendRef.current = null;
    awaitingReplyRef.current = true;
    send();
  }, [thread.draft, storageLoaded, sending, send]);

  // When a turn finishes, grab the assistant reply, auto-speak it, and surface
  // the now-playing replay card.
  useEffect(() => {
    const wasSending = prevSendingRef.current;
    prevSendingRef.current = sending;
    if (!(wasSending && !sending && awaitingReplyRef.current)) return;
    awaitingReplyRef.current = false;

    const reply = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.text.trim().length > 0);
    if (!reply) {
      goPhase("idle");
      return;
    }
    lastReplyTextRef.current = reply.text;
    carPlaySession.setReplyPreview(reply.text);
    goPhase("speaking");
    void speakReply(reply.text, reply.id);
  }, [sending, messages, goPhase]);

  // Safety net: if dictation ends without producing a turn (silence, denied
  // mic, or a cancelled recording), don't leave the listening/thinking surface
  // stuck — fall back to idle. Guarded so it never disturbs a live reply.
  useEffect(() => {
    if (dictation.status !== "idle") return;
    if (pendingSendRef.current || awaitingReplyRef.current) return;
    if (phaseRef.current === "listening" || phaseRef.current === "thinking") {
      goPhase("idle");
    }
  }, [dictation.status, goPhase]);

  // Stop any in-flight speech if CarPlay drops mid-reply.
  useEffect(() => {
    return () => {
      stopReadAloud();
    };
  }, []);

  // Mark `readAloud` as observed so its updates keep this component live for the
  // session's lifetime (the value itself is surfaced through the templates).
  void readAloud;

  return null;
}
