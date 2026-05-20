import { useMemo } from "react";
import { Image, PixelRatio, StyleSheet, Text, View } from "react-native";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

/** Rasterized from `assets/stella-logo.svg` (same asset as desktop/launcher). */
const STELLA_LOGO =
  PixelRatio.get() >= 3
    ? require("../../assets/stella-logo-84.png")
    : require("../../assets/stella-logo-56.png");

export function StellaBrandMark() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={styles.root}>
      <Image
        source={STELLA_LOGO}
        style={styles.logo}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
      <Text style={styles.wordmark}>Stella</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingBottom: 20,
      paddingHorizontal: 20,
    },
    logo: {
      height: 28,
      opacity: 0.55,
      width: 28,
    },
    wordmark: {
      color: colors.textMuted,
      fontFamily: fonts.display.regularItalic,
      fontSize: 22,
      letterSpacing: -0.4,
      lineHeight: 24,
    },
  });
