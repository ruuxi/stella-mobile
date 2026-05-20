/**
 * Mobile counterpart to desktop's `rehype-word-fade` + `stellaWordFadeIn`.
 *
 * Streaming text reveal: while an assistant message is mid-stream we bucket
 * every `WORDS_PER_GROUP` words into one `<Animated.Text>` that fades opacity
 * 0 → 1 once when first mounted. The trailing partial group grows in place
 * as new tokens arrive (its content updates without restarting the
 * animation); only when it fills up does the next group spawn as a fresh
 * sibling — which is the moment the next fade fires. Overlapping fades
 * give the soft "wave" reveal.
 *
 * Why a time-based ledger: `react-native-markdown-display` regenerates a
 * fresh `getUniqueID()` key for every AST node on every parse (i.e. every
 * ~33 ms stream flush). React therefore unmounts and remounts every span on
 * every update. A boolean "already shown" ledger made each remount snap to
 * full opacity before the 600 ms fade could register — which is why the
 * mask looked like it wasn't there at all. The ledger stores when each
 * group's fade *started*; remounts resume from elapsed progress instead of
 * restarting or skipping.
 *
 * Group ids are character offsets only (not the text payload) so the
 * trailing partial group keeps the same id as it grows word-by-word.
 *
 * Skip rules: text inside code/fence/code_inline is rendered by the
 * library's dedicated rules and never reaches our `text` rule.
 */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { Animated, Easing, Text } from "react-native";

/**
 * 3 reads as a small phrase at typical streaming cadence — long enough
 * that the eye registers a single soft fade rather than a flurry of
 * per-word events, short enough that the trailing reveal still tracks
 * the cursor closely. Matches desktop's `WORDS_PER_GROUP`.
 */
const WORDS_PER_GROUP = 3;
const FADE_DURATION_MS = 600;

const WHITESPACE_RE = /^\s+$/;

/** Group id (char offset) → fade start timestamp (ms). */
type Ledger = Map<string, number>;

const LedgerContext = createContext<Ledger | null>(null);

/**
 * One ledger per message instance. The map persists across re-renders so
 * remounts caused by the markdown library's unstable AST keys resume the
 * in-flight fade instead of snapping to visible.
 */
export function useStreamingLedger(): Ledger {
  const ref = useRef<Ledger | null>(null);
  if (ref.current === null) {
    ref.current = new Map();
  }
  return ref.current;
}

export function StreamingLedgerProvider({
  ledger,
  children,
}: {
  ledger: Ledger;
  children: ReactNode;
}) {
  return (
    <LedgerContext.Provider value={ledger}>{children}</LedgerContext.Provider>
  );
}

function fadeProgress(ledger: Ledger, id: string, now = Date.now()): number {
  let startedAt = ledger.get(id);
  if (startedAt === undefined) {
    startedAt = now;
    ledger.set(id, startedAt);
    return 0;
  }
  return Math.min(1, (now - startedAt) / FADE_DURATION_MS);
}

/**
 * Split a text run into alternating whitespace and non-whitespace
 * tokens, preserving the original character sequence exactly so that
 * `tokens.join('') === input`.
 */
function tokenize(value: string): string[] {
  const out: string[] = [];
  const re = /\s+|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) out.push(match[0]);
  return out;
}

type Chunk =
  | { kind: "group"; text: string; offset: number }
  | { kind: "ws"; text: string };

/**
 * Bucket the flat token stream into reveal groups. Each group bundles up
 * to WORDS_PER_GROUP consecutive words plus the whitespace between
 * them. The whitespace that separates two groups stays outside any
 * animated span (a bare string child of the wrapping Text) so word
 * spacing across group boundaries always renders naturally.
 *
 * Mirrors `groupTokens` in `desktop/src/app/chat/rehype-word-fade.ts`.
 */
function groupTokens(tokens: string[], baseOffset: number): Chunk[] {
  const out: Chunk[] = [];
  let buffer = "";
  let wordCount = 0;
  let pendingSeparator = "";
  let groupStartOffset = baseOffset;
  let cursor = baseOffset;

  const flush = () => {
    if (buffer.length === 0) return;
    out.push({ kind: "group", text: buffer, offset: groupStartOffset });
    buffer = "";
    wordCount = 0;
  };

  for (const tok of tokens) {
    if (WHITESPACE_RE.test(tok)) {
      if (wordCount === 0) {
        out.push({ kind: "ws", text: tok });
        cursor += tok.length;
      } else {
        pendingSeparator += tok;
      }
      continue;
    }
    if (wordCount === 0) {
      groupStartOffset = cursor;
      buffer = tok;
      wordCount = 1;
      cursor += tok.length;
    } else {
      buffer = buffer + pendingSeparator + tok;
      cursor += pendingSeparator.length + tok.length;
      pendingSeparator = "";
      wordCount += 1;
    }
    if (wordCount >= WORDS_PER_GROUP) {
      flush();
      if (pendingSeparator.length > 0) {
        out.push({ kind: "ws", text: pendingSeparator });
        cursor += pendingSeparator.length;
        pendingSeparator = "";
      }
    }
  }
  flush();
  if (pendingSeparator.length > 0) {
    out.push({ kind: "ws", text: pendingSeparator });
  }
  return out;
}

function AnimatedWordGroup({ id, text }: { id: string; text: string }) {
  const ledger = useContext(LedgerContext);
  const initialProgress =
    ledger === null ? 1 : fadeProgress(ledger, id);
  const opacityRef = useRef(new Animated.Value(initialProgress));

  useLayoutEffect(() => {
    if (ledger === null) return;
    const startedAt = ledger.get(id);
    if (startedAt === undefined) return;

    const elapsed = Date.now() - startedAt;
    const progress = Math.min(1, elapsed / FADE_DURATION_MS);
    opacityRef.current.setValue(progress);

    const remaining = FADE_DURATION_MS - elapsed;
    if (remaining <= 0) {
      opacityRef.current.setValue(1);
      return;
    }

    const anim = Animated.timing(opacityRef.current, {
      toValue: 1,
      duration: remaining,
      easing: Easing.out(Easing.quad),
      // Nested Text opacity can fail silently with the native driver on
      // some Android builds — the fade never registers and text looks
      // fully opaque from the first frame.
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
  }, [id, ledger]);

  if (initialProgress >= 1) {
    return <Text>{text}</Text>;
  }

  return (
    <Animated.Text style={{ opacity: opacityRef.current }}>
      {text}
    </Animated.Text>
  );
}

/**
 * Signature of the `text` render rule accepted by `react-native-markdown-display`.
 * Mirrors the library's untyped JS signature.
 */
export type StreamingTextRule = (
  node: { key: string; content: string },
  children: unknown,
  parent: unknown,
  styles: Record<string, unknown>,
  inheritedStyles?: Record<string, unknown>,
) => ReactNode;

/**
 * Build a fresh streaming `text` rule. The returned function owns a
 * private cursor that tracks the running character offset within the
 * message as the renderer walks AST text nodes in document order. The
 * offset becomes each group's stable id across re-parses.
 *
 * Call this once per render of the owning `<Markdown>` — the cursor
 * needs to start at 0 for every render pass.
 */
export function createStreamingTextRule(): StreamingTextRule {
  let cursor = 0;

  return (node, _children, _parent, styles, inheritedStyles = {}) => {
    const content = node.content ?? "";
    const textStyle = [
      inheritedStyles as Record<string, unknown>,
      styles.text as Record<string, unknown>,
    ];

    const startOffset = cursor;
    cursor += content.length;

    if (content.length === 0) {
      return <Text key={`t${startOffset}`} style={textStyle} />;
    }

    // Pure whitespace runs (e.g. between formatted spans) don't fade —
    // they have no glyphs to reveal and shouldn't add to the span count.
    if (WHITESPACE_RE.test(content)) {
      return (
        <Text key={`t${startOffset}`} style={textStyle}>
          {content}
        </Text>
      );
    }

    const chunks = groupTokens(tokenize(content), startOffset);

    const children: ReactNode[] = [];
    chunks.forEach((chunk, i) => {
      if (chunk.kind === "ws") {
        children.push(chunk.text);
      } else {
        // Offset-only id: the trailing partial group keeps the same id
        // as it grows, so its fade doesn't restart when more words land.
        const id = String(chunk.offset);
        children.push(
          <AnimatedWordGroup key={`g${id}`} id={id} text={chunk.text} />,
        );
      }
    });

    return (
      <Text key={`t${startOffset}`} style={textStyle}>
        {children}
      </Text>
    );
  };
}
