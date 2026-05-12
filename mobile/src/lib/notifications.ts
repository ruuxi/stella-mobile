import { AppState, Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { postJson } from "./http";
import { getOrCreateMobileDeviceId } from "./phone-access";

Notifications.setNotificationHandler({
  handleNotification: async () => {
    // Don't pop a banner over the app the user is currently looking at —
    // they're already watching their reply stream in. Still log it to the
    // notification list so they can find it later.
    const isForeground = AppState.currentState === "active";
    return {
      shouldShowAlert: !isForeground,
      shouldShowBanner: !isForeground,
      shouldShowList: true,
      shouldPlaySound: !isForeground,
      shouldSetBadge: false,
    };
  },
});

async function getExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) return null;

  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

let registered = false;

/** Register for push notifications and send the token to the backend. */
export async function registerForPushNotifications(): Promise<void> {
  if (registered) return;

  try {
    const token = await getExpoPushToken();
    if (!token) return;

    const mobileDeviceId = await getOrCreateMobileDeviceId();
    await postJson("/api/mobile/push-token", {
      token,
      platform: Platform.OS,
      mobileDeviceId,
    });
    registered = true;
  } catch {
    // Best-effort — don't block the app if registration fails.
  }
}

/** Get the Expo push notification listener for navigation. */
export const addNotificationResponseListener =
  Notifications.addNotificationResponseReceivedListener;
