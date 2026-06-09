import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isGuest } from "../../src/lib/guest-mode";
import { SignInPrompt } from "../../src/components/SignInPrompt";
import { Icon, type IconName } from "../../src/components/Icon";
import {
  getDesktopBridgeStatus,
  getPreferredPhoneAccess,
  requestDesktopConnection,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import { loadChatMessages } from "../../src/lib/offline-chat-storage";
import { updateStellaWidget } from "../../src/lib/home-widget";
import { tapLight, notifySuccess } from "../../src/lib/haptics";
import { useComputerModelSettings } from "../../src/lib/use-computer-model-settings";
import {
  useTopBarStatus,
  type DesktopConnection,
} from "../../src/lib/top-bar-status";
import { useColors } from "../../src/theme/theme-context";
import { type Colors } from "../../src/theme/colors";
import { fonts } from "../../src/theme/fonts";
import { fadeHex } from "../../src/theme/oklch";
import type { ChatArtifact } from "../../src/types";
import { ArtifactViewer } from "../../src/components/ArtifactViewer";
import { ArtifactListSheet } from "../../src/components/ArtifactListSheet";
import { ComputerSettingsSheet } from "../../src/components/ComputerSettingsSheet";
import { ConnectHeroAnimation } from "../../src/components/ConnectHeroAnimation";
import { PairPhoneSheet } from "../../src/components/PairPhoneSheet";

const STATUS_POLL_MS = 20_000;
/** Faster cadence while a wake request is in flight. */
const WAKE_POLL_MS = 3_000;
const WAKE_WINDOW_MS = 30_000;
const MAX_LISTED_ARTIFACTS = 20;

type DeviceStatus = {
  checking: boolean;
  available: boolean | null;
  platform: string | null;
};

/**
 * The Computer tab is the paired desktop's device surface: status, wake,
 * view-screen, artifacts, and model settings. The conversation itself lives
 * on the Chat tab, which routes to this computer automatically.
 */
export default function ComputerScreen() {
  const guest = isGuest();
  if (guest) {
    return <GuestComputerSurface />;
  }
  return <PairedComputerSurface />;
}

function GuestComputerSurface() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.centerSurface}>
      <View style={styles.heroBlock}>
        <ConnectHeroAnimation />
        <Text style={styles.heroTitle}>Your computer, at your fingertips</Text>
        <Text style={styles.heroBody}>
          Ask Stella to do things on your computer — browse the web, manage
          files, run tasks, and more.
        </Text>
      </View>
      <View style={styles.signInSection}>
        <SignInPrompt />
      </View>
    </View>
  );
}

function PairedComputerSurface() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const modelSettings = useComputerModelSettings();
  const { setConnection: setTopBarConnection } = useTopBarStatus();

  const [phoneAccess, setPhoneAccess] = useState<StoredPhoneAccess | null>(
    null,
  );
  const [paired, setPaired] = useState<boolean | null>(null);
  const [pairSheetOpen, setPairSheetOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<ChatArtifact | null>(
    null,
  );
  const [artifacts, setArtifacts] = useState<ChatArtifact[]>([]);
  const [status, setStatus] = useState<DeviceStatus>({
    checking: true,
    available: null,
    platform: null,
  });
  const [waking, setWaking] = useState(false);
  const wakeUntilRef = useRef(0);

  useEffect(() => {
    void getPreferredPhoneAccess().then((access) => {
      setPhoneAccess(access);
      setPaired(Boolean(access));
      if (!access) {
        updateStellaWidget({ paired: false, online: false });
      }
    });
  }, []);

  // Artifacts come from the unified chat transcript — newest first, deduped.
  useEffect(() => {
    void loadChatMessages().then((messages) => {
      const seen = new Set<string>();
      const out: ChatArtifact[] = [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        for (const artifact of messages[i].artifacts ?? []) {
          if (seen.has(artifact.id)) continue;
          seen.add(artifact.id);
          out.push(artifact);
          if (out.length >= MAX_LISTED_ARTIFACTS) break;
        }
        if (out.length >= MAX_LISTED_ARTIFACTS) break;
      }
      setArtifacts(out);
    });
  }, []);

  const checkStatus = useCallback(async (desktopDeviceId: string) => {
    try {
      const next = await getDesktopBridgeStatus(desktopDeviceId);
      setStatus({
        checking: false,
        available: next.available,
        platform: next.platform,
      });
      updateStellaWidget({
        paired: true,
        online: next.available,
        ...(next.platform ? { platform: next.platform } : {}),
      });
      return next.available;
    } catch {
      setStatus((prev) => ({ ...prev, checking: false, available: false }));
      return false;
    }
  }, []);

  // Poll bridge availability while the surface is mounted; tighten the
  // cadence while a wake request is pending.
  useEffect(() => {
    if (!phoneAccess) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const available = await checkStatus(phoneAccess.desktopDeviceId);
      if (cancelled) return;
      const wakePending = !available && Date.now() < wakeUntilRef.current;
      if (available || !wakePending) {
        setWaking(false);
      }
      timer = setTimeout(
        () => void tick(),
        wakePending ? WAKE_POLL_MS : STATUS_POLL_MS,
      );
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [checkStatus, phoneAccess]);

  const connection: DesktopConnection | null =
    paired !== true
      ? null
      : status.checking || waking
        ? "connecting"
        : status.available
          ? "connected"
          : "disconnected";

  useEffect(() => {
    setTopBarConnection(connection);
  }, [connection, setTopBarConnection]);
  useEffect(() => () => setTopBarConnection(null), [setTopBarConnection]);

  useEffect(() => {
    if (status.available === true && waking) {
      notifySuccess();
      setWaking(false);
    }
  }, [status.available, waking]);

  const wake = useCallback(() => {
    if (!phoneAccess) return;
    tapLight();
    setWaking(true);
    wakeUntilRef.current = Date.now() + WAKE_WINDOW_MS;
    void requestDesktopConnection(phoneAccess).catch(() => setWaking(false));
  }, [phoneAccess]);

  if (paired === null) {
    return <View style={styles.centerSurface} />;
  }

  if (paired === false) {
    return (
      <View style={styles.centerSurface}>
        <View style={styles.heroBlock}>
          <ConnectHeroAnimation />
          <Text style={styles.heroTitle}>Pair your phone first</Text>
          <Text style={styles.heroBody}>
            Pair this phone with your Stella desktop so you can chat with it
            from anywhere. You only need to do it once.
          </Text>
          <Pressable
            onPress={() => setPairSheetOpen(true)}
            accessibilityLabel="Pair this phone"
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.primaryButtonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Pair phone</Text>
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

  const platformLabel = status.platform?.trim() || "Your computer";
  const statusLabel = status.checking
    ? "Checking\u2026"
    : waking
      ? "Waking up\u2026"
      : status.available
        ? "Connected"
        : "Asleep";

  const rows: {
    id: string;
    icon: IconName;
    label: string;
    trailing?: string;
    onPress: () => void;
  }[] = [
    {
      id: "view",
      icon: "monitor",
      label: "View screen",
      onPress: () => {
        tapLight();
        router.push("/stella");
      },
    },
    {
      id: "artifacts",
      icon: "box",
      label: "Artifacts",
      onPress: () => {
        tapLight();
        setArtifactsOpen(true);
      },
    },
    {
      id: "model",
      icon: "cpu",
      label: "Model",
      trailing: modelSettings.selectedModelLabel,
      onPress: () => {
        tapLight();
        setModelSheetOpen(true);
      },
    },
    {
      id: "pair",
      icon: "smartphone",
      label: "Pair another computer",
      onPress: () => {
        tapLight();
        setPairSheetOpen(true);
      },
    },
  ];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.scrollContent,
        { paddingBottom: 32 + insets.bottom },
      ]}
    >
      <View style={styles.deviceHero}>
        <ConnectHeroAnimation />
        <Text style={styles.deviceName}>{platformLabel}</Text>
        <View style={styles.statusRow}>
          {connection === "connecting" ? null : (
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor: status.available
                    ? colors.ok
                    : colors.textMuted,
                },
              ]}
            />
          )}
          <Text style={styles.statusText}>{statusLabel}</Text>
          {!status.checking && !status.available && !waking ? (
            <Pressable
              onPress={wake}
              hitSlop={8}
              accessibilityLabel="Wake your computer"
              style={({ pressed }) => pressed && styles.wakePressed}
            >
              <Text style={styles.wakeText}>Wake up</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.rowGroup}>
        {rows.map((row, index) => (
          <Pressable
            key={row.id}
            onPress={row.onPress}
            accessibilityLabel={row.label}
            style={({ pressed }) => [
              styles.row,
              index > 0 && styles.rowDivider,
              pressed && styles.rowPressed,
            ]}
          >
            <Icon
              name={row.icon}
              size={18}
              color={colors.textMuted}
              style={styles.rowIcon}
            />
            <Text style={styles.rowLabel}>{row.label}</Text>
            {row.trailing ? (
              <Text style={styles.rowTrailing} numberOfLines={1}>
                {row.trailing}
              </Text>
            ) : null}
            <Icon name="chevron-right" size={15} color={colors.textMuted} />
          </Pressable>
        ))}
      </View>

      <ComputerSettingsSheet
        visible={modelSheetOpen}
        onClose={() => setModelSheetOpen(false)}
        access={phoneAccess}
        catalog={modelSettings.catalog}
        onApplied={modelSettings.syncFromSnapshot}
      />
      <ArtifactListSheet
        visible={artifactsOpen}
        artifacts={artifacts}
        onClose={() => setArtifactsOpen(false)}
        onSelect={setSelectedArtifact}
      />
      <ArtifactViewer
        visible={Boolean(selectedArtifact)}
        artifact={selectedArtifact}
        access={phoneAccess}
        onClose={() => setSelectedArtifact(null)}
      />
      <PairPhoneSheet
        visible={pairSheetOpen}
        onClose={() => setPairSheetOpen(false)}
        onPaired={(access) => {
          setPhoneAccess(access);
          setPaired(true);
          setPairSheetOpen(false);
        }}
      />
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1 },
    scrollContent: { paddingTop: 8 },
    centerSurface: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: 24,
    },
    heroBlock: {
      alignItems: "center",
      gap: 8,
    },
    heroTitle: {
      color: colors.textMuted,
      fontFamily: fonts.display.regularItalic,
      fontSize: 22,
      letterSpacing: -0.5,
      opacity: 0.7,
      textAlign: "center",
    },
    heroBody: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      lineHeight: 22,
      marginTop: 8,
      maxWidth: 280,
      textAlign: "center",
    },
    signInSection: {
      alignItems: "center",
      marginTop: 28,
    },
    primaryButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 22,
      justifyContent: "center",
      marginTop: 16,
      minHeight: 44,
      paddingHorizontal: 28,
      paddingVertical: 12,
    },
    primaryButtonPressed: {
      opacity: 0.85,
    },
    primaryButtonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.3,
    },

    deviceHero: {
      alignItems: "center",
      gap: 4,
      marginTop: 32,
    },
    deviceName: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 26,
      letterSpacing: -1,
      marginTop: 4,
    },
    statusRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      marginTop: 2,
    },
    statusDot: {
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    statusText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    wakeText: {
      color: colors.accent,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
      marginLeft: 6,
    },
    wakePressed: {
      opacity: 0.7,
    },

    rowGroup: {
      marginTop: 36,
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 14,
      paddingVertical: 15,
    },
    rowDivider: {
      borderTopColor: fadeHex(colors.border, 0.7),
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    rowPressed: {
      opacity: 0.7,
    },
    rowIcon: {
      width: 22,
    },
    rowLabel: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    rowTrailing: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
      maxWidth: 140,
    },
  } as const);
