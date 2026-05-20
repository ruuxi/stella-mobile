export type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  /** Present when the user attached images (text may be a short label like "Photo"). */
  hasImage?: boolean;
  /**
   * URIs of attached photo thumbnails for user messages, up to a few.
   * Best-effort: the file paths come from `expo-image-picker` results so
   * they survive in-session reloads but may become unreachable after a
   * reinstall or if the user deletes the source image — the `<Image>`
   * fallback covers that gracefully.
   */
  thumbnailUris?: string[];
  /**
   * User message: the message is queued behind an in-flight reply and has
   * not been dispatched yet. Renders dimmed with a small "Queued" label.
   */
  queued?: boolean;
  /**
   * Assistant message: the user pressed Stop before the reply completed.
   * Renders with a trailing "Stopped" affordance.
   */
  stopped?: boolean;
};

export type DesktopBridgeStatus = {
  available: boolean;
  baseUrls: string[];
  platform: string | null;
  updatedAt: number | null;
};
