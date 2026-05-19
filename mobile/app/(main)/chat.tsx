import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutAnimation, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import {
  loadOfflineChatMessages,
  saveOfflineChatMessages,
} from "../../src/lib/offline-chat-storage";
import { postStream, postStreamAnonymous } from "../../src/lib/http";
import { hasAiConsent, grantAiConsent } from "../../src/lib/ai-consent";
import { isGuest } from "../../src/lib/guest-mode";
import { AiConsentModal } from "../../src/components/AiConsentModal";
import { getOrCreateMobileDeviceId } from "../../src/lib/phone-access";
import { userFacingError } from "../../src/lib/user-facing-error";
import { notifySuccess } from "../../src/lib/haptics";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import type { ChatMessage } from "../../src/types";
import { ChatPane } from "../../src/components/ChatPane";

const createId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export default function ChatScreen() {
  const colors = useColors();
  const guest = isGuest();
  const router = useRouter();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<
    ImagePicker.ImagePickerAsset[]
  >([]);
  const [sending, setSending] = useState(false);
  const [showConsentModal, setShowConsentModal] = useState(false);
  const pendingSendRef = useRef<(() => void) | null>(null);
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);

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

  const dictationHeaders = useMemo(() => {
    if (!guest || !mobileDeviceId) return undefined;
    return { "X-Stella-Mobile-Device-Id": mobileDeviceId };
  }, [guest, mobileDeviceId]);

  const canSubmit =
    (draft.trim().length > 0 || attachments.length > 0) && !sending;

  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending) return;

    if (!hasAiConsent()) {
      pendingSendRef.current = () => void send();
      setShowConsentModal(true);
      return;
    }

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

    LayoutAnimation.configureNext({
      duration: 350,
      update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
    });
    setMessages((m) => [...m, userMsg]);

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
  }, [attachments, draft, guest, messages, sending]);

  const onConsentAccept = useCallback(() => {
    void grantAiConsent().then(() => {
      setShowConsentModal(false);
      const pending = pendingSendRef.current;
      pendingSendRef.current = null;
      if (pending) pending();
    });
  }, []);

  const onConsentDecline = useCallback(() => {
    pendingSendRef.current = null;
    setShowConsentModal(false);
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
        draft={draft}
        onChangeDraft={setDraft}
        canSubmit={canSubmit}
        onSubmit={() => void send()}
        placeholder="Message Stella"
        enableAttachments
        attachments={attachments}
        onChangeAttachments={setAttachments}
        onViewComputer={() => router.push("/stella")}
        dictationAnonymous={guest}
        dictationHeaders={dictationHeaders}
      />
      <AiConsentModal
        visible={showConsentModal}
        onAccept={onConsentAccept}
        onDecline={onConsentDecline}
      />
    </View>
  );
}
