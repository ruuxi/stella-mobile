import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useColors } from "../theme/theme-context";
import { type Colors } from "../theme/colors";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type TopSheetProps = {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Fraction of the screen height the sheet occupies. Defaults to 80%. */
  heightFraction?: number;
};

/**
 * A page-sheet that anchors to the top of the screen and slides down into view.
 * Covers ~80% of the height, leaving the rest as a tappable scrim, with rounded
 * bottom corners. Used for the artifact viewer and the artifact list.
 */
export function TopSheet({
  visible,
  onClose,
  children,
  heightFraction = 0.8,
}: TopSheetProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { height } = useWindowDimensions();
  const sheetHeight = Math.round(height * heightFraction);

  const progress = useRef(new Animated.Value(0)).current;
  const [rendered, setRendered] = useState(visible);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      Animated.timing(progress, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: 220,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
    // `progress` is a stable ref; only react to visibility changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-sheetHeight, 0],
  });
  const backdropOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.4],
  });

  return (
    <Modal
      visible={rendered}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.fill}>
        <AnimatedPressable
          style={[styles.backdrop, { opacity: backdropOpacity }]}
          onPress={onClose}
          accessibilityLabel="Close"
        />
        <Animated.View
          style={[
            styles.shadow,
            { height: sheetHeight, transform: [{ translateY }] },
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.sheet}>{children}</View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    fill: {
      flex: 1,
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "#000000",
    },
    shadow: {
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.18,
      shadowRadius: 24,
    },
    sheet: {
      backgroundColor: colors.background,
      borderBottomLeftRadius: 26,
      borderBottomRightRadius: 26,
      flex: 1,
      overflow: "hidden",
    },
  });
