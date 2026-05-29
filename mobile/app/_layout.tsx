import { useCallback, useMemo, useState } from "react";
import { Stack, usePathname, useRouter } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { loadAsync, useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import {
  ConvexBetterAuthProvider,
  type AuthClient,
} from "@convex-dev/better-auth/react";
import { authClient } from "../src/lib/auth-client";
import { getConvexClient } from "../src/lib/convex";
import { hasMobileConfig } from "../src/config/env";
import {
  installNotificationCategoriesAndListeners,
  registerForPushNotifications,
} from "../src/lib/notifications";
import { installTextDefaults } from "../src/lib/setup-text-defaults";

installTextDefaults();
import { loadGuestMode, isGuest, setGuestMode } from "../src/lib/guest-mode";
import { loadAiConsent } from "../src/lib/ai-consent";
import { loadNotificationsMuted } from "../src/lib/notifications-prefs";
import { loadLastMainTabHref } from "../src/lib/last-main-tab";
import {
  criticalStellaFontAssets,
  deferredStellaFontAssets,
} from "../src/theme/fonts";
import { ThemeProvider } from "../src/theme/theme-context";
import { ChatSearchProvider } from "../src/lib/chat-search";

void SplashScreen.preventAutoHideAsync();

function RootStack() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="auth" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(main)" />
    </Stack>
  );
}

function AuthenticatedLayout() {
  const session = authClient.useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [guestReady, setGuestReady] = useState(false);
  const [initialMainHref, setInitialMainHref] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      loadGuestMode(),
      loadAiConsent(),
      loadNotificationsMuted(),
      loadLastMainTabHref(),
    ]).then(([, , , href]) => {
      setInitialMainHref(href);
      setGuestReady(true);
    });
  }, []);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    let cancelled = false;
    void installNotificationCategoriesAndListeners().then((unsubscribe) => {
      if (cancelled) {
        unsubscribe();
        return;
      }
      dispose = unsubscribe;
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (session.isPending || !guestReady || !initialMainHref) {
      return;
    }

    const onAuthCallback =
      pathname === "/auth" || pathname.startsWith("/auth/");
    const onLogin = pathname === "/login";
    const onIndex = pathname === "/" || pathname === "";
    const onMain =
      pathname.startsWith("/chat") ||
      pathname.startsWith("/computer") ||
      pathname.startsWith("/stella") ||
      pathname.startsWith("/account");

    if (onAuthCallback) {
      return;
    }

    if (session.data) {
      if (isGuest()) void setGuestMode(false);
      void registerForPushNotifications();
      if (onLogin || onIndex) {
        router.replace(initialMainHref);
      }
      return;
    }

    if (isGuest()) {
      // Guests may open /login from Sign in buttons — don't bounce them back to chat.
      if (onIndex) {
        router.replace(initialMainHref);
      }
      return;
    }

    if (onMain || onIndex) {
      router.replace("/login");
    }
  }, [pathname, router, session.data, session.isPending, guestReady, initialMainHref]);

  return <RootStack />;
}

function AppLayout() {
  if (!hasMobileConfig) {
    return <RootStack />;
  }

  return <ConvexBoundLayout />;
}

function ConvexBoundLayout() {
  // Lazily create the Convex client once, after we've confirmed the
  // mobile config is present. `ConvexBetterAuthProvider` wires the
  // client's `setAuth` to Better Auth's JWT fetcher so authenticated
  // queries/mutations/actions work out of the box.
  const convex = useMemo(() => getConvexClient(), []);
  // `authClient` is a proxy whose generated type doesn't statically
  // expose `convex.token()` — it's added at runtime by the
  // `convexClient()` better-auth plugin. The provider just needs an
  // object with `convex.token()`, which we already verified the proxy
  // delegates correctly (see `src/lib/auth-token.ts`).
  const providerAuthClient = authClient as unknown as AuthClient;
  return (
    <ConvexBetterAuthProvider client={convex} authClient={providerAuthClient}>
      <AuthenticatedLayout />
    </ConvexBetterAuthProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts(criticalStellaFontAssets);

  useEffect(() => {
    if (!fontsLoaded) {
      return;
    }

    void loadAsync(deferredStellaFontAssets).catch(() => undefined);
  }, [fontsLoaded]);

  const onLayoutRootView = useCallback(() => {
    if (fontsLoaded) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider onLayout={onLayoutRootView}>
        <ThemeProvider>
          <ChatSearchProvider>
            <AppLayout />
          </ChatSearchProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
