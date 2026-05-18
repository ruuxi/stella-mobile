import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as WebBrowser from "expo-web-browser";
import { Icon } from "../../src/components/Icon";
import { authClient } from "../../src/lib/auth-client";
import { clearCachedToken } from "../../src/lib/auth-token";
import { isGuest } from "../../src/lib/guest-mode";
import { userFacingError } from "../../src/lib/user-facing-error";
import { tapLight } from "../../src/lib/haptics";
import {
  clearStoredPhoneAccess,
  getDesktopBridgeStatus,
  listStoredPairedPhoneAccess,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import {
  getNotificationsMuted,
  setNotificationsMuted,
  subscribeNotificationsMuted,
} from "../../src/lib/notifications-prefs";
import { GlassCard } from "../../src/components/GlassCard";
import { type Colors } from "../../src/theme/colors";
import {
  useColors,
  useTheme,
  type ThemePreference,
} from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const UPGRADE_URL = "https://stella.sh/pricing";

function platformLabelFor(
  access: StoredPhoneAccess,
  platform: string | null | undefined,
): string {
  const base = platform?.trim();
  if (base) return base;
  return `Computer · ${access.desktopDeviceId.slice(0, 4).toUpperCase()}`;
}

export default function AccountScreen() {
  const colors = useColors();
  const {
    preference,
    setPreference,
    theme: activeTheme,
    setThemeId,
    themes,
    isDark,
  } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const session = authClient.useSession();
  const guest = isGuest();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [pairedDesktops, setPairedDesktops] = useState<StoredPhoneAccess[]>([]);
  const [desktopPlatforms, setDesktopPlatforms] = useState<
    Record<string, string | null>
  >({});
  const [removingDesktopId, setRemovingDesktopId] = useState<string | null>(
    null,
  );
  const [notificationsMuted, setMutedLocal] = useState(() =>
    getNotificationsMuted(),
  );

  useEffect(() => subscribeNotificationsMuted(setMutedLocal), []);

  const user = session.data?.user;
  const email = user?.email ?? "";
  const displayName = user?.name?.trim() || email;
  // The whole "you have an account" surface — name/email header, upgrade card,
  // paired computers, sign-out, delete — only makes sense when the user has a
  // real session. Settings, appearance, notifications, and legal all work
  // without one, so we render the page either way and just hide the bits
  // that need an identity.
  const isSignedIn = Boolean(user) && !guest;
  const showLoadingHeader = !guest && session.isPending && !user;

  const refreshPaired = useCallback(async () => {
    const next = await listStoredPairedPhoneAccess();
    setPairedDesktops(next);
  }, []);

  useEffect(() => {
    void refreshPaired();
  }, [refreshPaired]);

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

  const signOut = async () => {
    setIsSigningOut(true);
    try {
      await authClient.signOut();
      clearCachedToken();
    } finally {
      setIsSigningOut(false);
    }
  };

  const runDeleteAccount = async () => {
    setIsDeletingAccount(true);
    try {
      const client = authClient as unknown as {
        deleteUser?: (args?: { callbackURL?: string }) => Promise<unknown>;
      };
      if (typeof client.deleteUser !== "function") {
        throw new Error("Account deletion is not available in this build.");
      }
      await client.deleteUser({});
      clearCachedToken();
      await authClient.signOut();
    } catch (e) {
      Alert.alert("Could not delete account", userFacingError(e));
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const confirmDeleteAccount = () => {
    Alert.alert(
      "Delete account",
      "This permanently deletes your Stella account and removes cloud data associated with it on our servers. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => void runDeleteAccount(),
        },
      ],
    );
  };

  const confirmForgetDesktop = (access: StoredPhoneAccess) => {
    const label = platformLabelFor(
      access,
      desktopPlatforms[access.desktopDeviceId],
    );
    Alert.alert(
      `Forget ${label}?`,
      "This phone will stop reconnecting to that computer until you pair it again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => {
            setRemovingDesktopId(access.desktopDeviceId);
            void clearStoredPhoneAccess(access.desktopDeviceId)
              .then(() => refreshPaired())
              .finally(() => setRemovingDesktopId(null));
          },
        },
      ],
    );
  };

  const openUpgrade = () => {
    tapLight();
    void WebBrowser.openBrowserAsync(UPGRADE_URL).catch(() => {
      void Linking.openURL(UPGRADE_URL);
    });
  };

  const toggleNotifications = (next: boolean) => {
    tapLight();
    setMutedLocal(!next);
    void setNotificationsMuted(!next);
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.scrollContent,
        { paddingBottom: 32 + insets.bottom },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Settings</Text>

      {isSignedIn ? (
        <>
          <View style={styles.identityBlock}>
            <Text style={styles.identityName} numberOfLines={1}>
              {displayName}
            </Text>
            {email && email !== displayName ? (
              <Text style={styles.identityEmail} numberOfLines={1}>
                {email}
              </Text>
            ) : null}
          </View>

          <GlassCard radius={14} ringed style={styles.upgradeCardWrap}>
            <Pressable
              onPress={openUpgrade}
              accessibilityLabel="Upgrade your Stella plan"
              style={({ pressed }) => [
                styles.upgradeCard,
                pressed && styles.upgradeCardPressed,
              ]}
            >
              <View style={styles.upgradeCopy}>
                <Text style={styles.upgradeTitle}>Stella Pro</Text>
                <Text style={styles.upgradeSub}>
                  Higher usage, faster replies, voice and image.
                </Text>
              </View>
              <Icon name="arrow-up-right" size={18} color={colors.accent} weight="semibold" />
            </Pressable>
          </GlassCard>
        </>
      ) : showLoadingHeader ? (
        <Text style={styles.body}>Loading session…</Text>
      ) : (
        <View style={styles.signInBlock}>
          <Text style={styles.signInTitle}>Sign in to Stella</Text>
          <Text style={styles.signInSub}>
            Sync your account, manage paired computers, and unlock cloud
            features.
          </Text>
          <Pressable
            onPress={() => router.replace("/login")}
            accessibilityLabel="Sign in to Stella"
            style={({ pressed }) => [
              styles.signInButton,
              pressed && styles.signInButtonPressed,
            ]}
          >
            <Text style={styles.signInButtonText}>Sign in</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.separator} />

      <Text style={styles.sectionLabel}>Appearance</Text>
      <View style={styles.themeRow}>
        {APPEARANCE_OPTIONS.map((opt) => (
          <Pressable
            key={opt.value}
            onPress={() => {
              tapLight();
              setPreference(opt.value);
            }}
            accessibilityLabel={`Use ${opt.label} appearance`}
            style={[
              styles.themeOption,
              preference === opt.value && styles.themeOptionActive,
            ]}
          >
            <Text
              style={[
                styles.themeOptionText,
                preference === opt.value && styles.themeOptionTextActive,
              ]}
            >
              {opt.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.themeDots}>
        {themes.map((th) => {
          const preview = isDark ? th.dark : th.light;
          const isActive = th.id === activeTheme.id;
          return (
            <Pressable
              key={th.id}
              onPress={() => {
                tapLight();
                setThemeId(th.id);
              }}
              accessibilityLabel={`Use ${th.name} theme`}
              accessibilityState={{ selected: isActive }}
              style={[
                styles.themeDotOuter,
                isActive && { borderColor: colors.accent },
              ]}
            >
              <View
                style={[
                  styles.themeDotInner,
                  { backgroundColor: preview.accent },
                ]}
              />
            </Pressable>
          );
        })}
      </View>

      <View style={styles.separator} />

      <Text style={styles.sectionLabel}>Notifications</Text>
      <View style={styles.toggleRow}>
        <View style={styles.toggleCopy}>
          <Text style={styles.toggleLabel}>Allow push notifications</Text>
          <Text style={styles.toggleSub}>
            Get notified when your computer finishes a request.
          </Text>
        </View>
        <Switch
          value={!notificationsMuted}
          onValueChange={toggleNotifications}
          accessibilityLabel="Toggle push notifications"
        />
      </View>

      {isSignedIn ? (
        <>
          <View style={styles.separator} />

          <Text style={styles.sectionLabel}>Paired computers</Text>
          {pairedDesktops.length === 0 ? (
            <Text style={styles.emptyHint}>
              No computers paired yet. Pair from the Desktop tab.
            </Text>
          ) : (
            <View style={styles.pairedList}>
              {pairedDesktops.map((access) => {
                const label = platformLabelFor(
                  access,
                  desktopPlatforms[access.desktopDeviceId],
                );
                const removing =
                  removingDesktopId === access.desktopDeviceId;
                return (
                  <GlassCard
                    key={access.desktopDeviceId}
                    radius={12}
                    ringed
                    style={styles.pairedRow}
                  >
                    <View style={styles.pairedCopy}>
                      <Text style={styles.pairedName}>{label}</Text>
                      <Text style={styles.pairedSub}>
                        Paired{" "}
                        {new Date(access.approvedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => confirmForgetDesktop(access)}
                      disabled={removing}
                      accessibilityLabel={`Forget ${label}`}
                      style={({ pressed }) => [
                        styles.forgetButton,
                        pressed && styles.forgetButtonPressed,
                        removing && styles.forgetButtonDisabled,
                      ]}
                    >
                      <Text style={styles.forgetText}>
                        {removing ? "\u2026" : "Forget"}
                      </Text>
                    </Pressable>
                  </GlassCard>
                );
              })}
            </View>
          )}
        </>
      ) : null}

      <View style={styles.separator} />

      <View style={styles.legalBlock}>
        <GlassCard radius={12} ringed style={styles.legalRowWrap}>
          <Pressable
            onPress={() => void Linking.openURL("https://stella.sh/terms")}
            accessibilityLabel="Open Terms of Service"
            style={({ pressed }) => [
              styles.legalRow,
              pressed && styles.legalRowPressed,
            ]}
          >
            <Text style={styles.legalLabel}>Terms of Service</Text>
            <Text style={styles.legalChevron}>›</Text>
          </Pressable>
        </GlassCard>
        <GlassCard radius={12} ringed style={styles.legalRowWrap}>
          <Pressable
            onPress={() => void Linking.openURL("https://stella.sh/privacy")}
            accessibilityLabel="Open Privacy Policy"
            style={({ pressed }) => [
              styles.legalRow,
              pressed && styles.legalRowPressed,
            ]}
          >
            <Text style={styles.legalLabel}>Privacy Policy</Text>
            <Text style={styles.legalChevron}>›</Text>
          </Pressable>
        </GlassCard>
      </View>

      {isSignedIn ? (
        <>
          <Pressable
            onPress={() => void signOut()}
            disabled={isSigningOut || isDeletingAccount}
            accessibilityLabel="Sign out of Stella"
            style={({ pressed }) => [
              styles.signOut,
              pressed && styles.signOutPressed,
              (isSigningOut || isDeletingAccount) && styles.signOutDisabled,
            ]}
          >
            <Text style={styles.signOutText}>
              {isSigningOut ? "Signing out\u2026" : "Sign out"}
            </Text>
          </Pressable>

          <Pressable
            onPress={confirmDeleteAccount}
            disabled={isDeletingAccount || isSigningOut}
            accessibilityLabel="Delete your Stella account"
            style={({ pressed }) => [
              styles.deleteAccountLink,
              pressed && styles.deleteAccountLinkPressed,
            ]}
          >
            <Text style={styles.deleteAccountLinkText}>
              {isDeletingAccount ? "Deleting account\u2026" : "Delete account"}
            </Text>
          </Pressable>
        </>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
    },
    scrollContent: {
      paddingTop: 8,
      paddingBottom: 32,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 28,
      letterSpacing: -1.2,
    },
    body: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      marginTop: 4,
    },
    separator: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
      marginVertical: 20,
    },
    sectionLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: 0.3,
      marginBottom: 10,
      textTransform: "uppercase",
    },
    identityBlock: {
      gap: 2,
      marginTop: 10,
    },
    identityName: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
    },
    identityEmail: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    upgradeCardWrap: {
      marginTop: 16,
    },
    upgradeCard: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    upgradeCardPressed: {
      opacity: 0.85,
    },
    signInBlock: {
      gap: 6,
      marginTop: 14,
      marginBottom: 4,
    },
    signInTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
    },
    signInSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      letterSpacing: -0.1,
      lineHeight: 20,
    },
    signInButton: {
      alignItems: "center",
      alignSelf: "flex-start",
      backgroundColor: colors.accent,
      borderRadius: 22,
      marginTop: 10,
      paddingHorizontal: 24,
      paddingVertical: 11,
    },
    signInButtonPressed: {
      backgroundColor: colors.accentHover,
    },
    signInButtonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.3,
    },
    upgradeCopy: {
      flex: 1,
      gap: 2,
    },
    upgradeTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
      letterSpacing: -0.3,
    },
    upgradeSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    themeRow: {
      flexDirection: "row",
      gap: 8,
      marginBottom: 16,
    },
    themeOption: {
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 16,
      paddingVertical: 9,
    },
    themeOptionActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    themeOptionText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    themeOptionTextActive: {
      color: colors.accentForeground,
    },
    themeDots: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
    },
    themeDotOuter: {
      alignItems: "center",
      borderColor: "transparent",
      borderRadius: 18,
      borderWidth: 2,
      justifyContent: "center",
      padding: 2,
    },
    themeDotInner: {
      borderRadius: 12,
      height: 24,
      width: 24,
    },
    toggleRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 16,
    },
    toggleCopy: {
      flex: 1,
      gap: 2,
    },
    toggleLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    toggleSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    emptyHint: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
    },
    pairedList: {
      gap: 6,
    },
    pairedRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    pairedCopy: {
      flex: 1,
      gap: 2,
    },
    pairedName: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    pairedSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
    },
    forgetButton: {
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    forgetButtonPressed: {
      opacity: 0.6,
    },
    forgetButtonDisabled: {
      opacity: 0.4,
    },
    forgetText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    legalBlock: {
      gap: 4,
      marginBottom: 12,
      marginTop: 8,
    },
    legalRowWrap: {},
    legalRow: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    legalRowPressed: {
      opacity: 0.85,
    },
    legalLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    legalChevron: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 18,
    },
    signOut: {
      alignItems: "center",
      alignSelf: "flex-start",
      borderColor: colors.border,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: 8,
      paddingHorizontal: 24,
      paddingVertical: 12,
    },
    signOutPressed: {
      opacity: 0.8,
    },
    signOutDisabled: {
      opacity: 0.5,
    },
    signOutText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.3,
    },
    deleteAccountLink: {
      alignSelf: "flex-start",
      marginTop: 20,
      paddingVertical: 8,
    },
    deleteAccountLinkPressed: {
      opacity: 0.6,
    },
    deleteAccountLinkText: {
      color: colors.danger,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
      textDecorationLine: "underline",
    },
  } as const);
