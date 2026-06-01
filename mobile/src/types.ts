export type MobileDisplayFileArtifactKind =
  | "office-document"
  | "office-spreadsheet"
  | "office-slides"
  | "delimited-table";

export type MobileMediaAsset =
  | { kind: "image"; filePaths: string[] }
  | { kind: "video"; filePath: string }
  | { kind: "audio"; filePath: string }
  | { kind: "model3d"; filePath: string; label?: string }
  | { kind: "download"; filePath: string; label: string }
  | { kind: "text"; text: string };

export type MobileOfficePreviewRef = {
  sessionId: string;
  title: string;
  sourcePath: string;
};

export type MobileDisplayPayload =
  | {
      kind: "canvas-html";
      filePath: string;
      title?: string;
      slug?: string;
      createdAt: number;
    }
  | { kind: "url"; url: string; title: string; tabId: string; tooltip?: string }
  | { kind: "office"; previewRef: MobileOfficePreviewRef; title?: string }
  | {
      kind: "markdown";
      filePath: string;
      title?: string;
      createdAt?: number;
    }
  | {
      kind: "source-diff";
      filePath: string;
      title?: string;
      patch?: string;
      createdAt?: number;
    }
  | {
      kind: "file-artifact";
      filePath: string;
      artifactKind: MobileDisplayFileArtifactKind;
      title?: string;
      createdAt?: number;
    }
  | { kind: "pdf"; filePath: string; title?: string }
  | {
      kind: "media";
      asset: MobileMediaAsset;
      createdAt: number;
      prompt?: string;
      capability?: string;
    };

export type ChatArtifact = {
  id: string;
  conversationId: string;
  payload: MobileDisplayPayload;
};

export type ChatMessage = {
  id: string;
  /**
   * Desktop-local message id this row reconciled to. Mobile keeps `id` stable
   * for the just-streamed row so sync does not remount the bubble.
   */
  canonicalId?: string;
  role: "assistant" | "user";
  text: string;
  artifacts?: ChatArtifact[];
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
