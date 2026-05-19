import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  loadComputerChatMessages,
  saveComputerChatMessages,
} from "../../src/lib/offline-chat-storage";
import { isGuest } from "../../src/lib/guest-mode";
import { SignInPrompt } from "../../src/components/SignInPrompt";
import {
  getOrCreateMobileDeviceId,
  getPreferredPhoneAccess,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import { userFacingError } from "../../src/lib/user-facing-error";
import { notifySuccess } from "../../src/lib/haptics";
import { useStellaModelSelection } from "../../src/lib/model-selection";
import {
  acknowledgeDesktopReplyRef,
  mobileSendChatRef,
  watchDesktopReplyRef,
} from "../../src/lib/convex-refs";
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

type PendingReply = {
  requestId: string;
  replyId: string;
};

const PENDING_REPLY_TIMEOUT_MS = 60_000;

function AuthenticatedComputerChat() {
  const colors = useColors();
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [mobileDeviceId, setMobileDeviceId] = useState<string | null>(null);
  const [paired, setPaired] = useState<boolean | null>(null);
  const [phoneAccess, setPhoneAccess] = useState<StoredPhoneAccess | null>(null);
  const [pendingReply, setPendingReply] = useState<PendingReply | null>(null);
  const modelSelection = useStellaModelSelection();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settledRequestIdsRef = useRef<Set<string>>(new Set());

  const sendChat = useAction(mobileSendChatRef);
  const acknowledgeReply = useMutation(acknowledgeDesktopReplyRef);

  // Subscribe to the active request's reply row. Convex tears the
  // subscription down automatically once we clear pendingReply (after
  // either a successful render or a timeout fallback).
  const replyRow = useQuery(
    watchDesktopReplyRef,
    pendingReply ? { requestId: pendingReply.requestId } : "skip",
  );

  useEffect(() => {
    void getOrCreateMobileDeviceId().then(setMobileDeviceId);
  }, []);

  useEffect(() => {
    void getPreferredPhoneAccess().then((access) => {
      setPhoneAccess(access);
      setPaired(Boolean(access));
    });
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

  const clearPendingTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const settlePendingReply = useCallback(
    (pending: PendingReply, text: string, ok: boolean) => {
      if (settledRequestIdsRef.current.has(pending.requestId)) return;
      settledRequestIdsRef.current.add(pending.requestId);
      clearPendingTimeout();
      setMessages((m) =>
        m.map((msg) =>
          msg.id === pending.replyId ? { ...msg, text } : msg,
        ),
      );
      if (ok) notifySuccess();
      setSending(false);
      setPendingReply(null);
      // Best-effort: tell the backend to drop the relayed row now that
      // the phone has it. Convex will TTL the row regardless, but
      // acking keeps Convex storage at "seconds in the happy path".
      void acknowledgeReply({ requestId: pending.requestId }).catch(() => {});
    },
    [acknowledgeReply, clearPendingTimeout],
  );

  // Reactive render: when the desktop publishes its reply, the
  // subscription delivers it here.
  useEffect(() => {
    if (!pendingReply || !replyRow || !replyRow.text) return;
    settlePendingReply(pendingReply, replyRow.text, true);
  }, [pendingReply, replyRow, settlePendingReply]);

  useEffect(() => clearPendingTimeout, [clearPendingTimeout]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || !mobileDeviceId || !phoneAccess) return;

    const userMsg: ChatMessage = { id: createId(), role: "user", text };
    const replyId = createId();

    setDraft("");
    setSending(true);
    LayoutAnimation.configureNext({
      duration: 350,
      update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
    });
    setMessages((m) => [
      ...m,
      userMsg,
      { id: replyId, role: "assistant", text: "" },
    ]);

    try {
      const result = await sendChat({
        message: text,
        mobileDeviceId,
        desktopDeviceId: phoneAccess.desktopDeviceId,
        pairSecret: phoneAccess.pairSecret,
        model: modelSelection.selectedModel,
      });
      if (result.kind === "sync" || result.kind === "unavailable") {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === replyId ? { ...msg, text: result.text } : msg,
          ),
        );
        if (result.kind === "sync") notifySuccess();
        setSending(false);
        return;
      }

      const pending: PendingReply = {
        requestId: result.requestId,
        replyId,
      };
      setPendingReply(pending);
      timeoutRef.current = setTimeout(() => {
        settlePendingReply(
          pending,
          "Stella didn\u2019t reply in time. Try again in a moment.",
          false,
        );
      }, PENDING_REPLY_TIMEOUT_MS);
    } catch (e) {
      const message = userFacingError(e);
      setMessages((m) =>
        m.map((msg) =>
          msg.id === replyId ? { ...msg, text: message } : msg,
        ),
      );
      setSending(false);
    }
  }, [
    draft,
    mobileDeviceId,
    modelSelection.selectedModel,
    phoneAccess,
    sendChat,
    sending,
    settlePendingReply,
  ]);

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
            onPress={() => router.push("/stella")}
            accessibilityLabel="Pair this phone"
            style={({ pressed }) => [
              styles.connectButton,
              pressed && styles.connectButtonPressed,
            ]}
          >
            <Text style={styles.connectButtonText}>Pair phone</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const canSubmit =
    draft.trim().length > 0 &&
    !sending &&
    paired === true &&
    Boolean(mobileDeviceId) &&
    Boolean(phoneAccess);

  return (
    <ChatPane
      messages={messages}
      streaming={sending}
      emptyContent={emptyContent}
      draft={draft}
      onChangeDraft={setDraft}
      canSubmit={canSubmit}
      onSubmit={() => void send()}
      placeholder="Ask Stella to do something"
      composerEnabled
      enableAttachments={false}
      onViewComputer={() => router.push("/stella")}
      selectedModel={modelSelection.selectedModel}
      selectedModelLabel={modelSelection.selectedModelLabel}
      modelOptions={modelSelection.models}
      onSelectModel={(modelId) => void modelSelection.selectModel(modelId)}
      dictationAnonymous={false}
      dictationHeaders={dictationHeaders}
    />
  );
}
