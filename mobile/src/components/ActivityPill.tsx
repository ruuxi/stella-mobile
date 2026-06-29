import { useMemo } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Icon } from "./Icon";
import { ShimmerText } from "./ShimmerText";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import type { MobileTask } from "../types";

const SHIMMER_MS = 1900;

const runningCountOf = (tasks: MobileTask[]) =>
  tasks.reduce((n, task) => (task.status === "running" ? n + 1 : n), 0);

/**
 * Activity pill above the composer (mobile port of the desktop
 * `ComposerActivityPill`). Shimmers a live count while background work runs and
 * opens the activity tray on tap. Hidden when there's no work to show.
 */
export function ActivityPill({
  tasks,
  colors,
  onPress,
}: {
  tasks: MobileTask[];
  colors: Colors;
  onPress: () => void;
}) {
  const styles = useMemo(() => makePillStyles(colors), [colors]);
  const running = runningCountOf(tasks);
  const isRunning = running > 0;
  const label = isRunning
    ? running > 1
      ? `${running} in progress`
      : "Task in progress"
    : "Activity";

  return (
    <Pressable
      onPress={onPress}
      style={styles.pill}
      accessibilityRole="button"
      accessibilityLabel="Open activity"
      hitSlop={6}
    >
      {!isRunning ? (
        <Icon name="cpu" size={13} color={colors.textMuted} />
      ) : null}
      {isRunning ? (
        <ShimmerText
          text={label}
          active
          color={colors.text}
          textStyle={styles.label}
          durationMs={SHIMMER_MS}
          dimAlpha={0.3}
        />
      ) : (
        <Text
          style={styles.label}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const TERMINAL_SUBTITLE: Record<
  Exclude<MobileTask["status"], "running">,
  string
> = {
  completed: "Finished",
  error: "Couldn’t finish",
  canceled: "Stopped",
};

function TaskRow({
  task,
  colors,
  styles,
}: {
  task: MobileTask;
  colors: Colors;
  styles: ReturnType<typeof makeTrayStyles>;
}) {
  const running = task.status === "running";
  const isError = task.status === "error";
  const subtitle =
    task.status === "running"
      ? task.statusText?.trim() || "Working in background"
      : TERMINAL_SUBTITLE[task.status];

  return (
    <View style={styles.taskRow}>
      <View style={styles.taskGlyph}>
        {running ? (
          <View style={styles.runningDot} />
        ) : task.status === "canceled" ? (
          <View style={styles.canceledDot} />
        ) : (
          <Icon
            name={isError ? "alert-circle" : "check"}
            size={15}
            color={isError ? colors.danger : colors.text}
          />
        )}
      </View>
      <View style={styles.taskText}>
        {running ? (
          <ShimmerText
            text={task.title}
            active
            color={colors.text}
            textStyle={styles.taskTitle}
            durationMs={SHIMMER_MS}
            dimAlpha={0.3}
          />
        ) : (
          <Text
            style={styles.taskTitle}
            numberOfLines={1}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {task.title}
          </Text>
        )}
        <Text
          style={styles.taskSub}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {subtitle}
        </Text>
      </View>
    </View>
  );
}

/** Bottom-sheet list of background tasks, opened by the activity pill. */
export function ActivityTray({
  visible,
  tasks,
  colors,
  onClose,
}: {
  visible: boolean;
  tasks: MobileTask[];
  colors: Colors;
  onClose: () => void;
}) {
  const styles = useMemo(() => makeTrayStyles(colors), [colors]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close activity" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title} maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}>
          Activity
        </Text>
        {tasks.length === 0 ? (
          <Text style={styles.empty} maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}>
            No background work yet.
          </Text>
        ) : (
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          >
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} colors={colors} styles={styles} />
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const makePillStyles = (colors: Colors) =>
  StyleSheet.create({
    pill: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 7,
      height: 28,
      paddingLeft: 11,
      paddingRight: 13,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.panel,
    },
    label: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
    },
  });

const makeTrayStyles = (colors: Colors) =>
  StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: colors.overlay,
    },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: "62%",
      backgroundColor: colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      paddingTop: 8,
      paddingBottom: 28,
      paddingHorizontal: 16,
    },
    handle: {
      alignSelf: "center",
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginBottom: 12,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
      marginBottom: 10,
      paddingHorizontal: 2,
    },
    empty: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      paddingVertical: 18,
      paddingHorizontal: 2,
    },
    list: {
      alignSelf: "stretch",
    },
    listContent: {
      gap: 4,
      paddingBottom: 4,
    },
    taskRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 11,
      paddingVertical: 8,
      paddingHorizontal: 2,
    },
    taskGlyph: {
      width: 20,
      height: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    runningDot: {
      width: 8,
      height: 8,
      borderRadius: 999,
      backgroundColor: colors.accent,
    },
    canceledDot: {
      width: 8,
      height: 8,
      borderRadius: 999,
      backgroundColor: colors.textMuted,
    },
    taskText: {
      flexShrink: 1,
      minWidth: 0,
    },
    taskTitle: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    taskSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      letterSpacing: -0.1,
      marginTop: 1,
    },
  });
