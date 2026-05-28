import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { Slot, usePathname, useRouter } from "expo-router";
import { AiConsentModal } from "../../src/components/AiConsentModal";
import {
  grantAiConsent,
  hasAiConsent,
  subscribeAiConsentRequested,
} from "../../src/lib/ai-consent";
import { authClient } from "../../src/lib/auth-client";
import { setGuestMode } from "../../src/lib/guest-mode";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Icon, type IconName } from "../../src/components/Icon";
import { GlassCard } from "../../src/components/GlassCard";
import { StellaBrandMark } from "../../src/components/StellaBrandMark";
import {
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { type Colors } from "../../src/theme/colors";
import { useColors, useTheme } from "../../src/theme/theme-context";
import { soften } from "../../src/theme/oklch";
import { fonts } from "../../src/theme/fonts";
import {
  MAIN_TAB_HREFS,
  readMainTabFromPath,
  saveLastMainTab,
  type MainTabId,
} from "../../src/lib/last-main-tab";

type TabId = MainTabId;

const TABS: {
  id: TabId;
  label: string;
  icon: IconName;
  href: string;
}[] = [
  { id: "chat", label: "Chat", icon: "message-square", href: "/chat" },
  { id: "account", label: "Settings", icon: "settings", href: "/account" },
];

const SIDEBAR_WIDTH = 320;
/** How far the foreground slides right when the drawer opens. Decoupled
 * from SIDEBAR_WIDTH so the sidebar can be widened (more breathing room
 * for its content) without pushing the main content further right. */
const DRAWER_REVEAL = 232;

function readActiveTab(pathname: string): TabId | null {
  const tab = readMainTabFromPath(pathname);
  if (tab) return tab;
  // /stella (desktop WebView) is reached from the composer "+" menu and
  // doesn't correspond to a sidebar entry — leave nothing highlighted.
  return null;
}

function Sidebar({
  activeTab,
  onSelectTab,
  colors,
  styles,
  tabs,
}: {
  activeTab: TabId | null;
  onSelectTab: (tab: TabId) => void;
  colors: Colors;
  styles: ReturnType<typeof makeStyles>;
  tabs: typeof TABS;
}) {
  const insets = useSafeAreaInsets();
  return (
    <GlassCard
      radius={0}
      style={[styles.sidebar, { paddingTop: insets.top + 12, paddingBottom: insets.bottom }]}
    >
      <StellaBrandMark />
      <View style={styles.nav}>
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <Pressable
              key={tab.id}
              onPress={() => onSelectTab(tab.id)}
              style={({ pressed }) => [
                styles.navItem,
                active && styles.navItemActive,
                pressed && styles.navItemPressed,
              ]}
            >
              <Icon
                name={tab.icon}
                size={18}
                color={active ? colors.accent : colors.textMuted}
                style={styles.navIcon}
                filled={active}
              />
              <Text
                style={[styles.navLabel, active && styles.navLabelActive]}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </GlassCard>
  );
}

export default function MainLayout() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [consentVisible, setConsentVisible] = useState(false);
  const colors = useColors();
  const { isDark, gradientMode } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => {
    if (!hasAiConsent()) {
      setConsentVisible(true);
    }
    return subscribeAiConsentRequested(() => {
      if (!hasAiConsent()) setConsentVisible(true);
    });
  }, []);

  const onConsentAccept = useCallback(() => {
    void grantAiConsent().then(() => setConsentVisible(false));
  }, []);

  const onConsentDecline = useCallback(() => {
    setConsentVisible(false);
    void (async () => {
      try {
        await authClient.signOut();
      } catch {
        /* ignore — guests have nothing to sign out of */
      }
      await setGuestMode(false);
      router.replace("/login");
    })();
  }, [router]);

  // Reanimated shared value: 0 = closed, 1 = fully open
  const drawerProgress = useSharedValue(0);

  const activeTab = readActiveTab(pathname);
  const onComputer = pathname === "/computer";

  useEffect(() => {
    if (activeTab) {
      void saveLastMainTab(activeTab);
    }
  }, [activeTab]);

  const openSidebar = () => {
    Keyboard.dismiss();
    setSidebarOpen(true);
    drawerProgress.value = withTiming(1, { duration: 280 });
  };

  const closeSidebar = () => {
    setSidebarOpen(false);
    drawerProgress.value = withTiming(0, { duration: 240 });
  };

  const navigate = (tab: TabId) => {
    router.replace(MAIN_TAB_HREFS[tab]);
    closeSidebar();
  };

  useEffect(() => {
    if (wide) closeSidebar();
  }, [wide]);

  // -- Gesture: swipe right anywhere on the app to open --
  // `Keyboard.dismiss` is a method on the native Keyboard module and isn't
  // serializable into the Worklets UI runtime, so wrap it in a plain JS
  // function before handing it to `runOnJS`.
  const dismissKeyboard = () => Keyboard.dismiss();
  const openPan = Gesture.Pan()
    .enabled(!sidebarOpen)
    .activeOffsetX(15)
    .failOffsetY([-20, 20])
    .onStart(() => {
      runOnJS(dismissKeyboard)();
    })
    .onUpdate((e) => {
      drawerProgress.value = Math.min(1, Math.max(0, e.translationX / DRAWER_REVEAL));
    })
    .onEnd((e) => {
      if (e.velocityX > 500 || drawerProgress.value > 0.4) {
        drawerProgress.value = withTiming(1, { duration: 200 });
        runOnJS(setSidebarOpen)(true);
      } else {
        drawerProgress.value = withTiming(0, { duration: 200 });
      }
    });

  // -- Gesture: swipe left to close --
  const makeCloseGesture = () =>
    Gesture.Pan()
      .enabled(sidebarOpen)
      .activeOffsetX(-15)
      .failOffsetY([-20, 20])
      .onUpdate((e) => {
        drawerProgress.value = Math.min(
          1,
          Math.max(0, 1 + e.translationX / DRAWER_REVEAL),
        );
      })
      .onEnd((e) => {
        if (e.velocityX < -500 || drawerProgress.value < 0.6) {
          drawerProgress.value = withTiming(0, { duration: 200 });
          runOnJS(setSidebarOpen)(false);
        } else {
          drawerProgress.value = withTiming(1, { duration: 200 });
        }
      });

  const closePanDrawer = makeCloseGesture();
  const drawerPan = sidebarOpen ? closePanDrawer : openPan;

  // -- Animated styles --
  // Sidebar sits underneath the foreground at rest. As the drawer opens we
  // gently fade and parallax it in (-12px → 0) so the reveal reads as the
  // content lifting away rather than the menu sliding in.
  const sidebarStyle = useAnimatedStyle(() => ({
    opacity: interpolate(drawerProgress.value, [0, 0.4, 1], [0, 0.6, 1]),
    transform: [
      {
        translateX: interpolate(drawerProgress.value, [0, 1], [-12, 0]),
      },
    ],
  }));

  // Foreground (top bar + content) is the elevated layer. It slides right
  // to expose the sidebar parked beneath it.
  const foregroundStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          drawerProgress.value,
          [0, 1],
          [0, DRAWER_REVEAL],
        ),
      },
    ],
  }));

  // Soft scrim painted onto the foreground itself — a faint dim while the
  // drawer is open, plus a tap-to-close target. Lives above content but
  // travels with the foreground so it never covers the sidebar.
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: drawerProgress.value * 0.18,
  }));

  // In flat mode (or when a forcedMode theme like Pearl/Noir is active) we
  // paint the plain theme background, matching the desktop Gradient → Flat
  // setting. Soft mode keeps the diagonal accent ↔ background ↔ ok blob.
  // Both fills are fully opaque so they double as the foreground's own
  // surface — covering the parked sidebar while letting the chosen mode
  // actually show through the app (a transparent foreground would leak the
  // sidebar). Rendered as a function so the same backdrop can sit behind the
  // shell (for the rounded-corner / drawer reveal) and inside the foreground.
  const renderGradient = () =>
    gradientMode === "flat" ? (
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]}
      />
    ) : (
      <LinearGradient
        colors={[
          soften(colors.accent, colors.background, isDark ? 0.1 : 0.14),
          colors.background,
          soften(colors.ok, colors.background, isDark ? 0.07 : 0.1),
        ]}
        locations={[0, 0.5, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    );

  return (
    // edges=[] disables SafeAreaView's auto-padding so every layer below
    // (gradient, sidebar, foreground) can extend edge-to-edge through the
    // status-bar and home-indicator regions. The chrome that needs to clear
    // those areas (top bar, chat composer, scrollable content) reads
    // `useSafeAreaInsets()` and pads itself.
    <SafeAreaView style={styles.shell} edges={[]}>
      <StatusBar style={isDark ? "light" : "dark"} />

      {wide ? (
        <>
          {renderGradient()}
          <View style={styles.wideLayout}>
            <Sidebar activeTab={activeTab} onSelectTab={navigate} colors={colors} styles={styles} tabs={TABS} />
            <View style={styles.content}>
              <View style={styles.contentSlot}>
                <Slot />
              </View>
            </View>
          </View>
        </>
      ) : (
        <View style={styles.narrowLayout}>
          {/* Gradient backdrop — painted behind both sidebar and foreground
              so the inset/rounded foreground reveals the same continuous
              canvas through its curved corners (no contrasting bands). */}
          {renderGradient()}
          {/* Sidebar parked underneath at the left edge. Always mounted,
              statically positioned, edge-to-edge vertically. The foreground
              (below) slides right to reveal it, so the menu reads as a layer
              the app is lifting off of rather than a panel sliding in over
              the content. */}
          <Animated.View
            pointerEvents={sidebarOpen ? "auto" : "none"}
            style={[styles.sidebarLayer, sidebarStyle]}
          >
            <Sidebar
              activeTab={activeTab}
              onSelectTab={navigate}
              colors={colors}
              styles={styles}
              tabs={TABS}
            />
          </Animated.View>

          {/* Foreground — the elevated layer. Top bar + content travel
              together, with a soft left-edge shadow for depth, and a scrim
              painted on top so taps behind the controls dismiss the drawer
              without ever obscuring the sidebar. */}
          <GestureDetector gesture={drawerPan}>
            <Animated.View style={[styles.foregroundLayer, foregroundStyle]}>
              {/* The foreground carries the backdrop as its own opaque surface
                  so soft/flat is actually visible in the app (and the parked
                  sidebar stays hidden) instead of being covered by a flat
                  fill. Clipped to the rounded corners via overflow:hidden. */}
              {renderGradient()}
              <View style={[styles.topBar, { height: insets.top + 36 }]}>
                <View style={styles.topBarSide}>
                  <Pressable
                    onPress={openSidebar}
                    hitSlop={8}
                    accessibilityLabel="Open navigation"
                    style={styles.hamburger}
                  >
                    <Icon name="menu" size={22} color={colors.text} weight="semibold" />
                  </Pressable>
                </View>
                <View style={styles.topBarCenter} pointerEvents="none">
                  <StellaBrandMark compact />
                </View>
                <View style={styles.topBarSide}>
                  <Pressable
                    onPress={() =>
                      router.replace(onComputer ? "/chat" : "/computer")
                    }
                    hitSlop={8}
                    accessibilityLabel={
                      onComputer ? "Back to chat" : "Open computer chat"
                    }
                    style={styles.hamburger}
                  >
                    <Icon
                      name={onComputer ? "message-square" : "monitor"}
                      size={22}
                      color={colors.text}
                      weight="regular"
                    />
                  </Pressable>
                </View>
              </View>

              <View style={styles.content}>
                <Slot />
              </View>

              {/* Scrim — sits on top of the foreground while the drawer is
                  open. Tap anywhere on the visible app area to close. */}
              <Animated.View
                pointerEvents={sidebarOpen ? "auto" : "none"}
                style={[styles.foregroundScrim, scrimStyle]}
              >
                <Pressable
                  onPress={closeSidebar}
                  style={StyleSheet.absoluteFill}
                  accessibilityLabel="Close navigation"
                />
              </Animated.View>
            </Animated.View>
          </GestureDetector>
        </View>
      )}
      <AiConsentModal
        visible={consentVisible}
        onAccept={onConsentAccept}
        onDecline={onConsentDecline}
      />
    </SafeAreaView>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // Wide (tablet / landscape)
  wideLayout: {
    flex: 1,
    flexDirection: "row",
  },

  // Narrow (phone)
  narrowLayout: {
    flex: 1,
  },

  // Top bar — phone only (hamburger | centered pill on Chat | action).
  // Height is set inline as `insets.top + barHeight` so the safe-area inset
  // is added on top of the bar's own height rather than eating into it
  // (RN box model is border-box, so a fixed `height` would absorb the inset).
  topBar: {
    alignItems: "flex-end",
    flexDirection: "row",
    paddingHorizontal: 4,
  },
  topBarSide: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  topBarCenter: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  topBarAction: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  hamburger: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  wideChatHeader: {
    alignItems: "center",
    marginBottom: 8,
  },
  contentSlot: {
    flex: 1,
    minHeight: 0,
  },
  // Sidebar
  sidebar: {
    flex: 1,
    width: SIDEBAR_WIDTH,
  },
  nav: {
    gap: 2,
    paddingHorizontal: 12,
  },
  navItem: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: 10,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    width: 188,
  },
  navItemActive: {
    backgroundColor: colors.accentSoft,
  },
  navItemPressed: {
    opacity: 0.7,
  },
  navIcon: {
    width: 20,
  },
  navLabel: {
    color: colors.text,
    fontFamily: fonts.sans.medium,
    fontSize: 15,
  },
  navLabelActive: {
    color: colors.accent,
  },

  // Sidebar layer — sits underneath the foreground, anchored to the left
  // edge. Stays mounted so swipe-to-open reveals an already-laid-out menu.
  sidebarLayer: {
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
    width: SIDEBAR_WIDTH,
    zIndex: 1,
  },

  // Foreground layer — elevated above the sidebar. Carries the canvas
  // color so the parked sidebar doesn't show through the app, and a soft
  // left-edge shadow so the layering reads when the drawer is open.
  foregroundLayer: {
    flex: 1,
    backgroundColor: colors.background,
    zIndex: 2,
    shadowColor: "#000",
    shadowOffset: { width: -2, height: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 12,
    overflow: "hidden",
    borderTopLeftRadius: 56,
    borderBottomLeftRadius: 56,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },

  // Scrim painted on the foreground while the drawer is open. Dims the
  // app slightly and provides a tap target to close.
  foregroundScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    zIndex: 3,
  },

  // Shared content area
  content: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 20,
    paddingTop: 4,
  },
} as const);
