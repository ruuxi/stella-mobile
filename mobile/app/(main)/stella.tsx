import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import {
  ActivityIndicator,
  BackHandler,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { assert, assertObject } from "../../src/lib/assert";
import { isGuest } from "../../src/lib/guest-mode";
import { getConvexToken } from "../../src/lib/auth-token";
import {
  buildPhoneAccessHeaders,
  clearStoredPhoneAccess,
  completePhonePairing,
  getDesktopBridgeStatus,
  getPreferredPhoneAccess,
  listStoredPairedPhoneAccess,
  requestDesktopConnection,
  setPreferredDesktopDeviceId,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import { generateShimScript } from "../../src/lib/shim";
import { registerStellaRefresh } from "../../src/lib/stella-refresh";
import { userFacingError } from "../../src/lib/user-facing-error";
import { DesktopTabAnimation } from "../../src/components/DesktopTabAnimation";
import { PairingQrScanner } from "../../src/components/PairingQrScanner";
import { SignInPrompt } from "../../src/components/SignInPrompt";
import { GlassCard } from "../../src/components/GlassCard";
import { notifyError, notifySuccess } from "../../src/lib/haptics";
import { type Colors } from "../../src/theme/colors";
import { useColors } from "../../src/theme/theme-context";
import { fadeHex } from "../../src/theme/oklch";
import { fonts } from "../../src/theme/fonts";

type MobileBridgeBootstrap = {
  localStorage: Record<string, string>;
};

const EMPTY_BRIDGE_BOOTSTRAP: MobileBridgeBootstrap = { localStorage: {} };
const DESKTOP_WAKE_ATTEMPTS = 8;
const DESKTOP_WAKE_RETRY_MS = 1_000;

type BridgeState = {
  bridgeUrl: string;
  token: string;
  uri: string;
  bootstrap: MobileBridgeBootstrap;
  access: StoredPhoneAccess;
};

type ScreenState =
  | { type: "loading"; message: string }
  | { type: "unavailable"; error: string | null; title: string }
  | { type: "ready"; bridge: BridgeState };

type ShimMessage =
  | { type: "openExternal"; url: string }
  | { type: "connectionState"; connected: boolean };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const PAIRING_CODE_LENGTH = 8;

const normalizePairingCode = (value: string) =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, PAIRING_CODE_LENGTH);

const shortDesktopId = (id: string) => id.slice(0, 4).toUpperCase();

const desktopChipLabel = (
  access: StoredPhoneAccess,
  platform: string | null | undefined,
  showSuffix: boolean,
): string => {
  const base = platform?.trim() || "Computer";
  if (!showSuffix) {
    return base;
  }
  return `${base} · ${shortDesktopId(access.desktopDeviceId)}`;
};

function getBridgeOrigin(bridgeUrl: string): string {
  return new URL(bridgeUrl).origin;
}

function isAllowedExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSameOriginUrl(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

function isAllowedWebViewUrl(value: string, origin: string): boolean {
  return value === "about:blank" || isSameOriginUrl(value, origin);
}

function readShimMessage(data: string): ShimMessage {
  const value = JSON.parse(data) as unknown;
  assertObject(value, "WebView message must be an object.");
  assert(typeof value.type === "string", "WebView message type is required.");
  switch (value.type) {
    case "openExternal":
      assert(typeof value.url === "string", "WebView URL is required.");
      return { type: "openExternal", url: value.url };
    case "connectionState":
      assert(
        typeof value.connected === "boolean",
        "WebView connected flag is required.",
      );
      return { type: "connectionState", connected: value.connected };
  }
  throw new Error(`Unknown WebView message type: ${value.type}`);
}

function readUnavailableState(
  title: string,
  error: string | null = null,
): Extract<ScreenState, { type: "unavailable" }> {
  return {
    type: "unavailable",
    error,
    title,
  };
}

function GuestDesktopScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.centered}>
      <DesktopTabAnimation />
      <Text style={styles.title}>Pair your phone</Text>
      <Text style={styles.body}>
        See your Stella desktop app right on your phone. After pairing, your phone will reconnect automatically.
      </Text>
      <SignInPrompt message="Sign in to get started." />
    </View>
  );
}

export default function StellaScreen() {
  if (isGuest()) {
    return <GuestDesktopScreen />;
  }

  return <AuthenticatedStellaScreen />;
}

function AuthenticatedStellaScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const webViewRef = useRef<WebView>(null);
  const preferredAccessRef = useRef<StoredPhoneAccess | null>(null);
  const screenStateRef = useRef<ScreenState["type"]>("loading");
  const attemptedRouteCodeRef = useRef<string | null>(null);
  const routeParams = useLocalSearchParams<{ code?: string | string[] }>();
  const routeCode = normalizePairingCode(
    typeof routeParams.code === "string"
      ? routeParams.code
      : Array.isArray(routeParams.code)
        ? (routeParams.code[0] ?? "")
        : "",
  );

  const [screenState, setScreenStateRaw] = useState<ScreenState>({
    type: "loading",
    message: "Connecting to desktop",
  });
  const setScreenState = useCallback((next: ScreenState) => {
    screenStateRef.current = next.type;
    setScreenStateRaw(next);
  }, []);
  const [canGoBack, setCanGoBack] = useState(false);
  const [bridgeConnected, setBridgeConnected] = useState(true);
  const [preferredAccess, setPreferredAccess] =
    useState<StoredPhoneAccess | null>(null);
  const [pairingCode, setPairingCode] = useState(routeCode);
  const [isPairing, setIsPairing] = useState(false);
  const [isScanningQr, setIsScanningQr] = useState(false);
  const [pairedDesktops, setPairedDesktops] = useState<StoredPhoneAccess[]>(
    [],
  );
  const [desktopPlatforms, setDesktopPlatforms] = useState<
    Record<string, string | null>
  >({});

  useEffect(() => {
    void listStoredPairedPhoneAccess().then(setPairedDesktops);
  }, [preferredAccess]);

  useEffect(() => {
    let cancelled = false;
    const missing = pairedDesktops.filter(
      (access) => !(access.desktopDeviceId in desktopPlatforms),
    );
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (access) => {
        try {
          const status = await getDesktopBridgeStatus(access.desktopDeviceId);
          return [access.desktopDeviceId, status.platform ?? null] as const;
        } catch {
          return [access.desktopDeviceId, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setDesktopPlatforms((prev) => {
        const next = { ...prev };
        for (const [id, platform] of entries) {
          next[id] = platform;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [desktopPlatforms, pairedDesktops]);

  const updatePreferredAccess = useCallback(
    (nextAccess: StoredPhoneAccess | null) => {
      preferredAccessRef.current = nextAccess;
      setPreferredAccess(nextAccess);
    },
    [],
  );

  const refreshBridge = useCallback(
    async (nextAccess?: StoredPhoneAccess | null) => {
      setScreenState({
        type: "loading",
        message: "Connecting to desktop",
      });

      const access =
        nextAccess === undefined
          ? (preferredAccessRef.current ?? (await getPreferredPhoneAccess()))
          : nextAccess;

      if (!access) {
        updatePreferredAccess(null);
        setPairedDesktops([]);
        setScreenState(readUnavailableState("Pair your phone"));
        return;
      }

      updatePreferredAccess(access);
      void listStoredPairedPhoneAccess().then(setPairedDesktops);

      try {
        await requestDesktopConnection(access);
        let status = await getDesktopBridgeStatus(access.desktopDeviceId);
        for (
          let attempt = 1;
          attempt < DESKTOP_WAKE_ATTEMPTS && !status.available;
          attempt += 1
        ) {
          await sleep(DESKTOP_WAKE_RETRY_MS);
          status = await getDesktopBridgeStatus(access.desktopDeviceId);
        }

        if (!status.available) {
          setScreenState(
            readUnavailableState(
              status.platform
                ? `Your ${status.platform} isn't reachable`
                : "Can't reach your desktop",
            ),
          );
          return;
        }

        const baseUrl = status.baseUrls[0];
        assert(baseUrl, "Desktop bridge URL is required.");
        const token = await getConvexToken();
        const accessHeaders = buildPhoneAccessHeaders(access);

        let bootstrap = EMPTY_BRIDGE_BOOTSTRAP;
        try {
          const bootstrapRes = await fetch(`${baseUrl}/bridge/bootstrap`, {
            headers: {
              Authorization: `Bearer ${token}`,
              ...accessHeaders,
            },
          });
          if (bootstrapRes.ok) {
            bootstrap = (await bootstrapRes.json()) as MobileBridgeBootstrap;
          }
        } catch {
          // Best-effort: proceed without desktop state.
        }

        notifySuccess();
        setBridgeConnected(true);
        setScreenState({
          type: "ready",
          bridge: {
            bridgeUrl: baseUrl,
            token,
            uri: `${baseUrl}/?mobile=1`,
            bootstrap,
            access,
          },
        });
      } catch (error) {
        const message = userFacingError(error);
        if (message.toLowerCase().includes("pair")) {
          await clearStoredPhoneAccess(access.desktopDeviceId);
          updatePreferredAccess(null);
          setScreenState(
            readUnavailableState(
              "Pair your phone",
              "This phone needs to be paired with your computer again.",
            ),
          );
          return;
        }

        setScreenState(
          readUnavailableState("Can't reach your desktop", message),
        );
      }
    },
    [updatePreferredAccess],
  );

  const pairPhone = useCallback(
    async (value?: string) => {
      const nextCode = normalizePairingCode(value ?? pairingCode);
      if (!nextCode) {
        setScreenState(
          readUnavailableState(
            "Pair your phone",
            "Enter the code shown on your computer.",
          ),
        );
        return;
      }

      setPairingCode(nextCode);
      setIsPairing(true);
      setScreenState({
        type: "loading",
        message: "Pairing this phone",
      });

      try {
        const access = await completePhonePairing({ pairingCode: nextCode });
        updatePreferredAccess(access);
        await refreshBridge(access);
      } catch (error) {
        notifyError();
        setScreenState(
          readUnavailableState("Pair your phone", userFacingError(error)),
        );
      } finally {
        setIsPairing(false);
      }
    },
    [pairingCode, refreshBridge, updatePreferredAccess],
  );

  useEffect(() => {
    void refreshBridge();
    const interval = setInterval(() => {
      const access = preferredAccessRef.current;
      if (!access || screenStateRef.current !== "ready") {
        return;
      }
      void getDesktopBridgeStatus(access.desktopDeviceId)
        .then((status) => {
          if (!status.available) {
            void refreshBridge(access);
          }
        })
        .catch(() => {});
    }, 45_000);
    registerStellaRefresh(() => void refreshBridge());
    return () => {
      clearInterval(interval);
      registerStellaRefresh(null);
    };
  }, [refreshBridge]);

  useEffect(() => {
    if (!routeCode || attemptedRouteCodeRef.current === routeCode) {
      return;
    }
    attemptedRouteCodeRef.current = routeCode;
    setPairingCode(routeCode);
    void pairPhone(routeCode);
  }, [pairPhone, routeCode]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const onBackPress = () => {
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBackPress);
    return () => sub.remove();
  }, [canGoBack]);

  const handleMessage = (event: WebViewMessageEvent) => {
    const message = readShimMessage(event.nativeEvent.data);
    if (message.type === "openExternal" && isAllowedExternalUrl(message.url)) {
      void Linking.openURL(message.url);
    }
    if (message.type === "connectionState") {
      setBridgeConnected(message.connected);
    }
  };

  if (screenState.type === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={colors.textMuted} />
        <Text style={styles.secondaryText}>{screenState.message}</Text>
      </View>
    );
  }

  if (screenState.type === "unavailable") {
    const showRetry = Boolean(preferredAccess);
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.unavailableScroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.statusBlock}>
          <DesktopTabAnimation />
          <Text style={styles.title}>{screenState.title}</Text>
          <Text style={styles.body}>
            {preferredAccess
              ? "Make sure Stella is open on your computer and connected to the internet. Once connected, your desktop app will appear right here on your phone."
              : "See your Stella desktop app right on your phone. Scan the QR code shown in Stella on your computer to get started — after that, your phone will reconnect automatically."}
          </Text>
          {screenState.error && (
            <Text style={styles.errorText}>{screenState.error}</Text>
          )}
          {preferredAccess && (
            <Text style={styles.caption}>
              Want to connect to a different computer? Enter a new code below.
            </Text>
          )}
        </View>

        {pairedDesktops.length > 1 ? (
          <View style={styles.switchDesktopRow}>
            <Text style={styles.inputLabel}>Paired computers</Text>
            <View style={styles.switchDesktopChips}>
              {pairedDesktops.map((d) => {
                const platform = desktopPlatforms[d.desktopDeviceId] ?? null;
                const samePlatformCount = pairedDesktops.filter(
                  (other) =>
                    (desktopPlatforms[other.desktopDeviceId] ?? null) ===
                    platform,
                ).length;
                return (
                  <Pressable
                    key={d.desktopDeviceId}
                    onPress={() => {
                      void setPreferredDesktopDeviceId(d.desktopDeviceId);
                      void refreshBridge(d);
                    }}
                    accessibilityLabel={`Switch to ${desktopChipLabel(d, platform, true)}`}
                    style={({ pressed }) => [
                      styles.desktopChip,
                      pressed && styles.desktopChipPressed,
                      preferredAccess?.desktopDeviceId === d.desktopDeviceId
                        ? styles.desktopChipActive
                        : null,
                    ]}
                  >
                    <Text style={styles.desktopChipText}>
                      {desktopChipLabel(d, platform, samePlatformCount > 1)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        <View style={styles.actionRow}>
          <Pressable
            onPress={() => setIsScanningQr(true)}
            disabled={isPairing}
            accessibilityLabel="Scan pairing QR code"
            style={({ pressed }) => [
              styles.actionButton,
              pressed && styles.actionButtonPressed,
              isPairing && styles.actionButtonDisabled,
            ]}
          >
            <Text style={styles.actionButtonText}>
              {preferredAccess ? "Pair another computer" : "Scan QR code"}
            </Text>
          </Pressable>

          {showRetry && (
            <Pressable
              onPress={() => void refreshBridge()}
              accessibilityLabel="Try connecting again"
              style={({ pressed }) => [
                styles.secondaryButton,
                pressed && styles.secondaryButtonPressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>Try again</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.manualCodeBlock}>
          <Text style={styles.manualCodeLabel}>or enter code manually</Text>
          <GlassCard radius={14} ringed>
            <TextInput
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardType="ascii-capable"
              maxLength={PAIRING_CODE_LENGTH}
              onChangeText={(value) =>
                setPairingCode(normalizePairingCode(value))
              }
              onSubmitEditing={() => void pairPhone()}
              placeholder="ABCDEFGH"
              placeholderTextColor={fadeHex(colors.textMuted, 0.3)}
              returnKeyType="go"
              style={styles.manualCodeInput}
              textContentType="oneTimeCode"
              value={pairingCode}
            />
          </GlassCard>
          <Pressable
            onPress={() => void pairPhone()}
            disabled={isPairing || pairingCode.length === 0}
            accessibilityLabel="Submit pairing code"
            style={({ pressed }) => [
              styles.manualCodeSubmit,
              pressed && styles.manualCodeSubmitPressed,
              (isPairing || pairingCode.length === 0) &&
                styles.manualCodeSubmitDisabled,
            ]}
          >
            <Text style={styles.manualCodeSubmitText}>
              {isPairing ? "Pairing\u2026" : "Pair with code"}
            </Text>
          </Pressable>
        </View>

        <PairingQrScanner
          visible={isScanningQr}
          onClose={() => setIsScanningQr(false)}
          onCodeScanned={(code) => {
            setIsScanningQr(false);
            setPairingCode(code);
            void pairPhone(code);
          }}
        />
      </ScrollView>
    );
  }

  const bridgeOrigin = getBridgeOrigin(screenState.bridge.bridgeUrl);
  return (
    <View style={styles.screenReady}>
      {!bridgeConnected && (
        <View style={styles.reconnectBanner}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text style={styles.reconnectText}>Reconnecting to desktop...</Text>
        </View>
      )}
      <View style={styles.webFrame}>
        <WebView
          ref={webViewRef}
          source={{
            uri: screenState.bridge.uri,
            headers: {
              Authorization: `Bearer ${screenState.bridge.token}`,
              ...buildPhoneAccessHeaders(screenState.bridge.access),
            },
          }}
          injectedJavaScriptBeforeContentLoaded={generateShimScript(
            screenState.bridge.bridgeUrl,
            screenState.bridge.bootstrap,
          )}
          style={styles.webView}
          onMessage={handleMessage}
          onNavigationStateChange={(nav) => setCanGoBack(nav.canGoBack)}
          onShouldStartLoadWithRequest={(request) => {
            if (isAllowedWebViewUrl(request.url, bridgeOrigin)) {
              return true;
            }
            if (isAllowedExternalUrl(request.url)) {
              void Linking.openURL(request.url);
            }
            return false;
          }}
          onError={() =>
            setScreenState(
              readUnavailableState(
                "Can't reach your desktop",
                "The link to your computer was interrupted.",
              ),
            )
          }
          onHttpError={(e) => {
            if (e.nativeEvent.statusCode >= 500) {
              setScreenState(readUnavailableState("Can't reach your desktop"));
            }
          }}
          originWhitelist={[bridgeOrigin, "about:blank"]}
        />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  screen: {
    flex: 1,
  },
  /** Main layout when WebView is shown (banner + frame). */
  screenReady: {
    flex: 1,
    gap: 12,
  },
  unavailableScroll: {
    flexGrow: 1,
    gap: 12,
    paddingBottom: 28,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
  },
  title: {
    color: colors.text,
    fontFamily: fonts.display.regular,
    fontSize: 28,
    letterSpacing: -1.2,
    textAlign: "center",
  },
  body: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    letterSpacing: -0.2,
    lineHeight: 22,
  },
  secondaryText: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 15,
  },
  errorText: {
    color: colors.danger,
    fontFamily: fonts.sans.regular,
    fontSize: 14,
    lineHeight: 20,
  },
  caption: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    letterSpacing: -0.1,
    lineHeight: 19,
  },
  statusBlock: {
    gap: 8,
    paddingTop: 8,
  },
  switchDesktopRow: {
    gap: 8,
    paddingHorizontal: 4,
  },
  switchDesktopChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  desktopChip: {
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  desktopChipPressed: {
    opacity: 0.85,
  },
  desktopChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.panel,
  },
  desktopChipText: {
    color: colors.text,
    fontFamily: fonts.sans.medium,
    fontSize: 13,
  },
  inputLabel: {
    color: colors.textMuted,
    fontFamily: fonts.sans.medium,
    fontSize: 13,
    letterSpacing: 0.2,
    textAlign: "center",
  },
  manualCodeBlock: {
    alignItems: "stretch",
    gap: 10,
    marginTop: 24,
  },
  manualCodeLabel: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    letterSpacing: -0.1,
    textAlign: "center",
  },
  manualCodeInput: {
    color: colors.text,
    fontFamily: fonts.sans.semiBold,
    fontSize: 22,
    letterSpacing: 6,
    paddingHorizontal: 14,
    paddingVertical: 16,
    textAlign: "center",
  },
  manualCodeSubmit: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  manualCodeSubmitPressed: {
    opacity: 0.8,
  },
  manualCodeSubmitDisabled: {
    opacity: 0.45,
  },
  manualCodeSubmitText: {
    color: colors.text,
    fontFamily: fonts.sans.medium,
    fontSize: 15,
    letterSpacing: -0.2,
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "center",
    marginTop: "auto",
  },
  actionButton: {
    alignItems: "center",
    backgroundColor: colors.accent,
    borderRadius: 22,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  actionButtonPressed: {
    opacity: 0.8,
  },
  actionButtonDisabled: {
    opacity: 0.65,
  },
  actionButtonText: {
    color: colors.accentForeground,
    fontFamily: fonts.sans.semiBold,
    fontSize: 15,
    letterSpacing: -0.3,
  },
  secondaryButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  secondaryButtonPressed: {
    opacity: 0.8,
  },
  secondaryButtonText: {
    color: colors.text,
    fontFamily: fonts.sans.medium,
    fontSize: 15,
    letterSpacing: -0.2,
  },
  reconnectBanner: {
    alignItems: "center",
    backgroundColor: colors.panel,
    borderRadius: 10,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  reconnectText: {
    color: colors.textMuted,
    fontFamily: fonts.sans.regular,
    fontSize: 13,
    letterSpacing: -0.1,
  },
  webFrame: {
    borderRadius: 14,
    flex: 1,
    overflow: "hidden",
  },
  webView: {
    flex: 1,
    backgroundColor: colors.surface,
  },
} as const);
