import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Icon } from "./Icon";
import type { MobileDisplayPayload } from "../types";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";

type AgentWorkPayload = Extract<MobileDisplayPayload, { kind: "agent-work" }>;

type AgentWorkCardProps = {
  payload: AgentWorkPayload;
  colors: Colors;
};

/**
 * Inline "background work" card — work the computer kicked off in the
 * background. Non-interactive (no detail view to open): it just reports that
 * Stella is working / has finished. State is sync-time, so a running card
 * flips to "Finished" on the next sync.
 */
export function AgentWorkCard({ payload, colors }: AgentWorkCardProps) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const running = payload.state === "running";

  return (
    <View
      style={styles.card}
      accessibilityRole="text"
      accessibilityLabel={`${payload.title}. ${payload.subtitle}`}
    >
      <View style={styles.iconWrap}>
        {running ? (
          <ActivityIndicator size="small" color={colors.text} />
        ) : (
          <Icon name="check" size={18} color={colors.text} />
        )}
      </View>
      <View style={styles.textWrap}>
        <Text
          style={styles.title}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {payload.title}
        </Text>
        <Text
          style={styles.subtitle}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {payload.subtitle}
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      alignItems: "center",
      alignSelf: "stretch",
      backgroundColor: fadeHex(colors.card, 0.8),
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      minHeight: 58,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    iconWrap: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      height: 36,
      justifyContent: "center",
      width: 36,
    },
    textWrap: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      letterSpacing: -0.1,
      marginTop: 2,
    },
  });
