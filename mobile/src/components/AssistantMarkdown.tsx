/**
 * Renders assistant message text with markdown formatting. Mobile counterpart
 * to desktop's streamdown render — streamdown itself is web-only (depends on
 * react-markdown / DOM), so we use `react-native-markdown-display` and apply
 * the same typography / colour tokens that the rest of the chat uses.
 *
 * Streaming tolerance: when an assistant reply is mid-stream, fenced code
 * blocks (```) and inline code (`) often arrive unbalanced for several
 * frames. We pad the input so partial blocks still render as code while the
 * model is typing, matching streamdown's "be forgiving about unclosed
 * markers" behaviour.
 */
import { useMemo } from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import Markdown, { MarkdownIt } from "react-native-markdown-display";
import * as WebBrowser from "expo-web-browser";
import { fadeHex } from "../theme/oklch";
import { fonts } from "../theme/fonts";
import type { Colors } from "../theme/colors";
const BASE_FONT_SIZE = 17;
const BASE_LINE_HEIGHT = BASE_FONT_SIZE * 1.45;

/** Balance trailing fences so partial code blocks still render while streaming. */
function tolerateStreamingMarkers(input: string): string {
  let text = input;
  const fenceMatches = text.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    text = `${text}\n\u200B\n\`\`\``;
  }
  const inlineMatches = (text.match(/`/g) ?? []).length;
  if (inlineMatches % 2 === 1) {
    text = `${text}\``;
  }
  return text;
}

const markdownIt = MarkdownIt({
  typographer: true,
  linkify: true,
  breaks: true,
  html: false,
});

function makeStyles(colors: Colors) {
  const codeBg = fadeHex(colors.muted, 0.35);
  const codeBorder = fadeHex(colors.border, 0.6);
  return StyleSheet.create({
    body: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: BASE_FONT_SIZE,
      letterSpacing: 0.03 * BASE_FONT_SIZE,
      lineHeight: BASE_LINE_HEIGHT,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 10,
    },
    heading1: {
      color: colors.textStrong,
      fontFamily: fonts.sans.semiBold,
      fontSize: 22,
      lineHeight: 22 * 1.3,
      marginTop: 12,
      marginBottom: 8,
    },
    heading2: {
      color: colors.textStrong,
      fontFamily: fonts.sans.semiBold,
      fontSize: 20,
      lineHeight: 20 * 1.3,
      marginTop: 12,
      marginBottom: 6,
    },
    heading3: {
      color: colors.textStrong,
      fontFamily: fonts.sans.semiBold,
      fontSize: 18,
      lineHeight: 18 * 1.3,
      marginTop: 10,
      marginBottom: 4,
    },
    heading4: {
      color: colors.textStrong,
      fontFamily: fonts.sans.medium,
      fontSize: BASE_FONT_SIZE,
      lineHeight: BASE_LINE_HEIGHT,
      marginTop: 8,
      marginBottom: 4,
    },
    heading5: {
      color: colors.textStrong,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      lineHeight: 15 * 1.4,
      marginTop: 8,
      marginBottom: 4,
    },
    heading6: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      lineHeight: 14 * 1.4,
      marginTop: 8,
      marginBottom: 4,
    },
    strong: { fontFamily: fonts.sans.semiBold },
    em: { fontStyle: "italic" },
    link: { color: colors.accent, textDecorationLine: "underline" },
    blockquote: {
      backgroundColor: fadeHex(colors.muted, 0.35),
      borderLeftColor: colors.borderStrong,
      borderLeftWidth: 3,
      paddingVertical: 6,
      paddingHorizontal: 12,
      marginVertical: 8,
      borderRadius: 6,
    },
    hr: {
      backgroundColor: colors.border,
      height: 1,
      marginVertical: 12,
    },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { marginBottom: 4 },
    bullet_list_icon: {
      color: colors.textMuted,
      marginRight: 8,
      lineHeight: BASE_LINE_HEIGHT,
    },
    ordered_list_icon: {
      color: colors.textMuted,
      marginRight: 8,
      lineHeight: BASE_LINE_HEIGHT,
    },
    code_inline: {
      backgroundColor: codeBg,
      borderColor: codeBorder,
      borderWidth: 1,
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: Platform.OS === "ios" ? 1 : 0,
      fontFamily: fonts.mono.regular,
      fontSize: BASE_FONT_SIZE - 1,
      color: colors.text,
    },
    code_block: {
      backgroundColor: codeBg,
      borderColor: codeBorder,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
      marginVertical: 8,
      fontFamily: fonts.mono.regular,
      fontSize: BASE_FONT_SIZE - 2,
      lineHeight: (BASE_FONT_SIZE - 2) * 1.5,
      color: colors.text,
    },
    fence: {
      backgroundColor: codeBg,
      borderColor: codeBorder,
      borderWidth: 1,
      borderRadius: 8,
      padding: 12,
      marginVertical: 8,
      fontFamily: fonts.mono.regular,
      fontSize: BASE_FONT_SIZE - 2,
      lineHeight: (BASE_FONT_SIZE - 2) * 1.5,
      color: colors.text,
    },
    table: {
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      marginVertical: 8,
    },
    thead: { backgroundColor: fadeHex(colors.muted, 0.4) },
    th: {
      padding: 8,
      fontFamily: fonts.sans.semiBold,
      color: colors.textStrong,
    },
    td: {
      padding: 8,
      borderTopColor: colors.borderWeak,
      borderTopWidth: 1,
    },
  });
}

async function openLink(url: string) {
  try {
    if (/^https?:\/\//i.test(url)) {
      await WebBrowser.openBrowserAsync(url);
    } else {
      await Linking.openURL(url);
    }
  } catch {
    // Swallow — link target may be malformed mid-stream.
  }
  return false;
}

export function AssistantMarkdown({
  text,
  colors,
}: {
  text: string;
  colors: Colors;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const source = useMemo(() => tolerateStreamingMarkers(text), [text]);

  return (
    // The wrapping View lets the parent Pressable still receive long-press —
    // markdown children render as Text/Views that don't intercept the gesture.
    <View>
      <Markdown
        style={styles}
        mergeStyle
        onLinkPress={(url) => {
          void openLink(url);
          return false;
        }}
        markdownit={markdownIt}
      >
        {source}
      </Markdown>
    </View>
  );
}
