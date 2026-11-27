// A key as the interface names it, and the status bar's row of key hints.
//
// A key cap (Visual language v2, NsVim's `Kbd`): 12pt mono on the raised
// surface inside one hairline, 20pt tall and at least as wide. The cap
// separates the key from its label by shape, so the pairs sit close together.
import { keymap, Text, View } from "nsh";
import { cx, FILL, LINE, RADIUS, sizedBox, TEXT, TYPE } from "./tokens";

export interface KbdProps {
  /** The key or chord: plain text ("j / k", "esc"), or a chord in any spelling ("mod-k", "Ctrl+Enter"), shown as this platform writes it ("⌘K" / "Ctrl+K"). */
  keys: string;
  /** `quiet` (default) draws the key in foreground text; `strong` in bright text, for a key inside a sentence. */
  variant?: "quiet" | "strong";
  testID?: string;
}

const MODIFIERS = new Set(["mod", "cmd", "command", "ctrl", "control", "alt", "option", "opt", "shift", "meta", "super"]);
const KEY_NAMES: Record<string, string> = { esc: "escape", return: "enter", del: "delete" };

/**
 * A chord with a modifier ("mod-k", "Ctrl+Enter", "shift+mod+p") as a
 * keystroke the router reads ("mod+k"), or null when `text` is no such chord
 * ("j / k", "esc", "?"). Ctrl is the router's `mod`, as in the keys table.
 */
export function chordKeystroke(text: string): string | null {
  const t = text.trim();
  if (t === "" || /\s/.test(t)) return null;
  const parts = t.split(/[-+]/).filter((p) => p !== "");
  if (parts.length < 2) return null;
  const keys = parts.map((p) => p.toLowerCase());
  const mods = keys.slice(0, -1);
  if (!mods.every((k) => MODIFIERS.has(k))) return null;
  const mapped = mods.map((k) => (k === "ctrl" || k === "control" || k === "cmd" || k === "command" || k === "meta" ? "mod" : k === "option" || k === "opt" ? "alt" : k));
  const key = keys[keys.length - 1];
  return [...mapped, KEY_NAMES[key] ?? key].join("+");
}

/**
 * A key or chord as this platform writes it on a cap: `mod-k` is "⌘K" on
 * Apple platforms and "Ctrl+K" elsewhere (through `keymap.label`); text that
 * is no chord is shown as given. Never shows "mod".
 */
export function keyCapLabel(text: string): string {
  const stroke = chordKeystroke(text);
  if (!stroke) return text;
  try {
    return keymap.label(stroke);
  } catch {
    return text.replace(/\bmod\b/gi, "Ctrl");
  }
}

/**
 * A chord as the caps it is drawn with: one cap on Apple platforms ("⌘K"),
 * one per key elsewhere ("Ctrl", "K").
 */
export function keyCapParts(text: string): string[] {
  const label = keyCapLabel(text);
  if (!chordKeystroke(text) || !label.includes("+")) return [label];
  return label.split("+").filter((p) => p !== "");
}

let apple: boolean | null = null;

/** Apple platforms, where the keys table's Ctrl (the router's `mod`) is Command. */
export function isApple(): boolean {
  if (apple === null) {
    try {
      apple = /⌘|Cmd/.test(keymap.label("mod+a"));
    } catch {
      apple = false;
    }
  }
  return apple;
}

/** A table chord's modifiers as this platform writes them, where `keymap.label` cannot ("Ctrl+" is "Cmd+" on Apple platforms). */
function platformKeys(text: string): string {
  return isApple() ? text.replace(/Ctrl\+/g, "Cmd+") : text;
}

/** Keys drawn as they are written rather than through `keymap.label`:
 * Escape reads better as "esc" than "⎋", and symbols typed with Shift
 * ("?") are what the user presses, not "⇧/". */
const AS_WRITTEN: Record<string, string> = { escape: "esc", esc: "esc", "?": "?", "+": "+" };
const TABLE_KEY: Record<string, string> = { ctrl: "mod", return: "enter", "+": "plus" };

/**
 * One chord of the keys table (`Ctrl+Enter`, `Shift+J`, `Ctrl++`,
 * `Ctrl+1…9`) as this platform writes it, through `keymap.label`: `⌘↩`,
 * `⇧J`, `⌘+`, `⌘1…9` on Apple platforms, `Ctrl+Enter` elsewhere. A single
 * key is a cap's ("j" is "J", "Down" "↓"); Escape is "esc" and "?" stays.
 * Never "mod".
 */
export function chordLabel(chord: string): string {
  const text = String(chord ?? "").trim();
  if (text === "") return "";
  // "Ctrl++": the key is the plus after the last modifier's plus.
  const plusKey = text.endsWith("++");
  const split = plusKey ? text.length - 1 : text.lastIndexOf("+");
  const modText = plusKey ? text.slice(0, text.length - 2) : text.slice(0, Math.max(split, 0));
  const mods = split > 0 ? modText.split("+").map((m) => TABLE_KEY[m.trim().toLowerCase()] ?? m.trim().toLowerCase()) : [];
  let key = plusKey ? "+" : split > 0 ? text.slice(split + 1) : text;
  // A digit range ("1…9", "1…0") labels its first digit and keeps the range.
  let range = "";
  const ranged = /^(\d)(…\d)$/.exec(key);
  if (ranged) {
    key = ranged[1];
    range = ranged[2];
  }
  const lower = key.toLowerCase();
  let prefix = "";
  if (mods.length > 0) {
    try {
      const sample = keymap.label([...mods, "a"].join("+"));
      prefix = sample.slice(0, sample.length - 1);
    } catch {
      prefix = platformKeys(text.slice(0, split + 1));
    }
  }
  let label: string;
  if (AS_WRITTEN[lower] !== undefined) label = AS_WRITTEN[lower];
  else {
    try {
      label = keymap.label(TABLE_KEY[lower] ?? lower);
    } catch {
      label = key.length === 1 ? key.toUpperCase() : key;
    }
  }
  return prefix + label + range;
}

/**
 * The key caps of a keys-table or hint text, one per key: alternatives
 * ("j, Down", "Shift+J / Shift+K") are separate caps, and the same key
 * written twice ("Return, Enter") one; a sequence ("g then i") stays one cap
 * with its steps spaced ("G I").
 */
export function keyCaps(text: string): string[] {
  const out: string[] = [];
  for (const alternative of String(text ?? "").split(/,\s+|\s+\/\s+/)) {
    const part = alternative.trim();
    if (part === "") continue;
    const cap = part.split(/\s+then\s+/).map(chordLabel).join(" ");
    if (cap !== "" && !out.includes(cap)) out.push(cap);
  }
  return out;
}

/** One key or chord, a mono key cap. `keys` may be a chord in any spelling ("mod-k"): it is shown as this platform writes it. */
export function Kbd(props: KbdProps) {
  return (
    <View
      testID={props.testID}
      role="keyboardkey"
      accessibilityLabel={keyCapLabel(props.keys)}
      class={cx(
        "items-center justify-center",
        sizedBox("h-[20px]", "h", 20),
        sizedBox("min-w-[20px]", "min-w", 20),
        sizedBox("px-[5px]", "px", 5),
        FILL.raised,
        LINE.border,
        RADIUS,
      )}
    >
      <Text class={cx(TYPE.sm, "leading-none", TEXT.mono, props.variant === "strong" ? "text-bright" : "text-foreground")}>
        {keyCapLabel(props.keys)}
      </Text>
    </View>
  );
}

/** One hint: what to press, and what it does. */
export interface KeyHint {
  /** The key, written for this platform ("j / k"). Hints and the bindings that run them come from one keymap. */
  key: string;
  /** What it does, lower case and short ("move", "open"). */
  label: string;
}

export interface KeyHintsProps {
  hints: readonly KeyHint[];
  /** `asWritten` (default): one cap per hint, its key as given. `perKey`: the key as the keys table writes it ("j / k", "Ctrl+Enter"), one cap per key (`keyCaps`). */
  caps?: "asWritten" | "perKey";
  testID?: string;
}

/**
 * The keys useful from here, as key and label pairs: a key is separated from
 * its label by its fill, and pairs from each other by a wider gap.
 */
export function KeyHints(props: KeyHintsProps) {
  return (
    <View testID={props.testID} class={cx("flex-row items-center gap-3")} accessibilityLabel="Keyboard shortcuts">
      <Each of={props.hints} key={(h) => `${h.key}\u0000${h.label}`}>
        {(hint) => (
          <View class={cx("flex-row items-center gap-1")}>
            <If when={props.caps === "perKey"}>
              <Each of={keyCaps(hint().key)} key="index">
                {(cap) => <Kbd keys={cap()} />}
              </Each>
            </If>
            <If when={props.caps !== "perKey"}>
              <Kbd keys={hint().key} />
            </If>
            <Text class={cx(TEXT.caption, "leading-none")}>{hint().label}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}
