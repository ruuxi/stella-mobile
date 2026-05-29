import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArtifactCard } from "./ArtifactCard";
import { TopSheet } from "./TopSheet";
import type { ChatArtifact } from "../types";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

type ArtifactListSheetProps = {
  visible: boolean;
  artifacts: ChatArtifact[];
  onClose: () => void;
  onSelect: (artifact: ChatArtifact) => void;
};

/**
 * Top page-sheet listing every artifact in the current conversation
 * (newest first) so the user can jump back to previous documents, canvases,
 * and media without scrolling the chat. Tapping a row opens the viewer.
 */
export function ArtifactListSheet({
  visible,
  artifacts,
  onClose,
  onSelect,
}: ArtifactListSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(
    () => makeStyles(colors, insets.top),
    [colors, insets.top],
  );

  const count = artifacts.length;

  return (
    <TopSheet visible={visible} onClose={onClose}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text
            style={styles.title}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            Artifacts
          </Text>
          {count > 0 ? (
            <Text
              style={styles.subtitle}
              numberOfLines={1}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {`${count} ${count === 1 ? "item" : "items"}`}
            </Text>
          ) : null}
        </View>
        {count === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No artifacts yet</Text>
            <Text style={styles.emptyBody}>
              Documents, canvases, and media Stella creates will show up here.
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            {artifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                colors={colors}
                onPress={onSelect}
              />
            ))}
          </ScrollView>
        )}
      </View>
    </TopSheet>
  );
}

const makeStyles = (colors: Colors, topInset: number) =>
  StyleSheet.create({
    root: {
      flex: 1,
    },
    header: {
      backgroundColor: colors.surface,
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      paddingBottom: 12,
      paddingHorizontal: 18,
      paddingTop: topInset + 12,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      marginTop: 2,
    },
    content: {
      gap: 10,
      paddingBottom: 28,
      paddingHorizontal: 16,
      paddingTop: 10,
    },
    empty: {
      alignItems: "center",
      flex: 1,
      gap: 6,
      justifyContent: "center",
      paddingBottom: 60,
      paddingHorizontal: 32,
    },
    emptyTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
      letterSpacing: -0.2,
    },
    emptyBody: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 19,
      textAlign: "center",
    },
  });
