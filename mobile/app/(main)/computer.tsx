import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutAnimation, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  loadComputerChatMessages,
  saveComputerChatMessages,
} from "../../src/lib/offline-chat-storage";
import { postStream } from "../../src/lib/http";
import { isGuest } from "../../src/lib/guest-mode";
import { SignInPrompt } from "../../src/components/SignInPrompt";
import {
  getOrCreateMobileDeviceId,
  getPreferredPhoneAccess,
} from "../../src/lib/phone-access";
import { userFacingError } from "../../src/lib/user-facing-error";
import { notifySuccess } from "../../src/lib/haptics";
import { startComputerLiveActivity } from "../../src/lib/live-activity";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import type { ChatMessage } from "../../src/types";
import { ChatPane } from "../../src/components/ChatPane";
import { ConnectHeroAnimation } from "../../src/components/ConnectHeroAnimation";

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
        block: {
          alignItems: "center",
          gap: 12,
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
        <View style={styles.block}>
          <ConnectHeroAnimation />
          <Text style={styles.title}>Your computer, at your fingertips</Text>
          <Text style={styles.body}>
            Ask Stella to do things on your computer — browse the web, manage
            files, run tasks, and more.
          </Text>
          <SignInPrompt message="Sign in to get started." />
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

function AuthenticatedComputerChat() {
  const colors = useColors();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);
  const [paired, setPaired] = useState<boolean | null>(null);

  useEffect(() => {
    void getOrCreateMobileDeviceId().then(setMobileDeviceId);
  }, []);

  useEffect(() => {
    void getPreferredPhoneAccess().then((access) => setPaired(Boolean(access)));
  }, []);

  useEffect(() => {
    void loadComputerChatMessages().then((loaded) => {
      setMessages(loaded);
      setStorageLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!storageLoaded) return;
    void saveComputerChatMessages(messages);
  }, [messages, storageLoaded]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !mobileDeviceId) return;

    const userMsg: ChatMessage = { id: createId(), role: "user", text };

    setDraft("");
    setSending(true);
    LayoutAnimation.configureNext({
      duration: 350,
      update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
    });
    setMessages((m) => [...m, userMsg]);

    const replyId = createId();
    setMessages((m) => [...m, { id: replyId, role: "assistant", text: "" }]);

    const activity = startComputerLiveActivity();
    let accumulated = "";

    try {
      await postStream(
        "/api/mobile/chat",
        { message: text, mobileDeviceId },
        (delta) => {
          accumulated += delta;
          activity.update(accumulated);
          setMessages((m) =>
            m.map((msg) =>
              msg.id === replyId
                ? { ...msg, text: msg.text + delta }
                : msg,
            ),
          );
        },
      );
      setMessages((m) =>
        m.map((msg) =>
          msg.id === replyId && !msg.text
            ? { ...msg, text: "No reply came back. Try again." }
            : msg,
        ),
      );
      activity.finish({ ok: true, preview: accumulated });
      notifySuccess();
    } catch (e) {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === replyId
            ? { ...msg, text: msg.text || userFacingError(e) }
            : msg,
        ),
      );
      activity.finish({ ok: false });
    } finally {
      setSending(false);
    }
  }, [draft, mobileDeviceId, sending]);

  const dictationHeaders = useMemo(() => undefined, []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        block: {
          alignItems: "center",
          gap: 8,
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
      }),
    [colors],
  );

  const emptyContent = useMemo(() => {
    if (paired === false) {
      return (
        <View style={styles.block}>
          <ConnectHeroAnimation />
          <Text style={styles.title}>Pair your phone first</Text>
          <Text style={styles.body}>
            Open View computer from the + menu to pair this phone with your
            Stella desktop. You only need to do it once.
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.block}>
        <ConnectHeroAnimation />
        <Text style={styles.title}>Your computer, at your fingertips</Text>
        <Text style={styles.body}>
          Ask Stella to do things on your computer — browse the web, manage
          files, run tasks, and more.
        </Text>
      </View>
    );
  }, [paired, styles]);

  const canSubmit =
    draft.trim().length > 0 && !sending && paired === true;

  return (
    <ChatPane
      messages={messages}
      streaming={sending}
      emptyContent={emptyContent}
      draft={draft}
      onChangeDraft={setDraft}
      canSubmit={canSubmit}
      onSubmit={() => void send()}
      placeholder={
        paired === false
          ? "Pair your phone to message your computer"
          : "Ask Stella to do something"
      }
      composerEnabled={paired !== false}
      enableAttachments={false}
      onViewComputer={() => router.push("/stella")}
      dictationAnonymous={false}
      dictationHeaders={dictationHeaders}
    />
  );
}
