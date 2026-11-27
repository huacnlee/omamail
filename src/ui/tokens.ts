// The ui layer's look as classes: one vocabulary every component below
// draws with, so a fill, a border or a text role means the same thing in
// every control. Colors are theme roles only (theme.json and theme.ts: the
// ink / paper palettes, or Omarchy's with the missing roles filled). The
// look follows docs/DESIGN.md "Visual language v2: after NsVim": flat, 2pt
// corners, depth from three ink steps and hairlines, hover `surface-raised`,
// selection the `selection` fill with brighter semibold text, the keyboard
// focus a 1pt primary ring inset on the item (no leading-edge bars).
//
// Features use TEXT for the text they lay out themselves; FILL, LINE and
// SIZE are for the ui layer's own components.
import { scaled, uiScale } from "./font";

/**
 * Interaction fills (Visual language v2): hover is `surface-raised`, the
 * selection is the `selection` fill with `SELECTED_TEXT`, pressed is the
 * selection. Selected wins over hover: give a selected row `FILL.selected`
 * and not `FILL.hover`.
 */
export const FILL = {
  rest: "bg-background",
  hover: "hover:bg-surface-raised",
  pressed: "active:bg-selection",
  selected: "bg-selection",
  /** The selected fill as a Button's `selected:` state. */
  selectedState: "selected:bg-selection",
  /** Popups, dialogs, toasts and tooltips. */
  surface: "bg-surface",
  /** Deep wells: sidebars, the status line, inset fields. */
  inset: "bg-muted",
  /** Hovered rows, key caps, table heads. */
  raised: "bg-surface-raised",
  /** Placeholder shapes (skeleton bars). */
  ghost: "bg-surface-raised",
} as const;

/** A selected item's text: brighter and semibold (with `FILL.selected`, never color alone). */
export const SELECTED_TEXT = "text-bright font-semibold";

/**
 * The keyboard focus of rows, nav items and other non-text controls: a 1pt
 * primary ring inset on the item's own silhouette, shown only when the
 * keyboard moved the focus (`focus-visible:`, never after a press). `rest`
 * reserves the ring's width so nothing moves when it shows. Text inputs use
 * `LINE.inputFocus` instead: they show it on any focus.
 */
export const RING = {
  rest: "border border-transparent",
  focus: "focus-visible:border-primary",
  /** Drawn now (a list's keyboard cursor away from the focus, a drop target). */
  on: "border-primary",
} as const;

/**
 * @deprecated Visual language v2 has no leading-edge bar (docs/DESIGN.md,
 * "Selection"): selection is `FILL.selected` with `SELECTED_TEXT`, focus is
 * `RING`. Kept so older code compiles: it draws the ring, never a bar.
 */
export const BAR = {
  rest: RING.rest,
  on: "",
  selectedState: "",
  focus: RING.focus,
} as const;

/** Lines: surfaces own one border each; controls reserve theirs. */
export const LINE = {
  /**
   * A structural line between the window's regions (a header's bottom, the
   * status line's top, a split's rest line, a bar's edge, a panel's edges):
   * `divider`, a hair above the background on Ink and Paper, the border on
   * Omarchy. Content borders (fields, popovers, tables, chips, cards) stay
   * `border`.
   */
  divider: "border-divider",
  /** A structural line drawn as a 1pt view: `divider`'s fill. */
  dividerFill: "bg-divider",
  hairline: "bg-border",
  border: "border border-border",
  /** An outer rule: panes' outer edges, titled panels' frames. */
  strong: "border border-rule-strong",
  /** A control's border, reserved and clear until a state draws it. */
  clear: "border border-transparent",
  control: "border border-border",
  /** The keyboard's focus on a non-text control: a 1pt primary border, keyboard only. */
  focus: "focus-visible:border-primary",
  /** A text input's focus (it holds the caret): a 1pt primary border on any focus. */
  inputFocus: "focus:border-primary",
  danger: "border border-danger",
} as const;

/**
 * Text sizes, drawn at Omarchy's base size 14 and scaled with `uiScale()`
 * (shell.toml `base-size`). Each reads the scale, so a class built in a
 * binding follows a change; at the default scale they are the plain classes.
 */
export const TYPE = {
  /** 11pt: the smallest letters (avatar initials, badges). */
  get xs(): string { return sizedText("text-[11px]", 11); },
  /** 12pt: captions, hints, metadata, key caps. */
  get sm(): string { return sizedText("text-xs", 12, 16); },
  /** 13pt: chrome body text, controls, menus. */
  get md(): string { return sizedText("text-[13px]", 13); },
  /** 14pt: a list row's title. */
  get body(): string { return sizedText("text-sm", 14, 20); },
  /** 16pt: pane titles. */
  get lg(): string { return sizedText("text-base", 16, 24); },
  /** 20pt: the reader's subject. */
  get xl(): string { return sizedText("text-xl", 20, 28); },
  /** 15pt with 1.6 lines (24pt): message text. */
  get message(): string { return sizedText("text-[15px] leading-[24px]", 15, 24); },
};

function sizedText(plain: string, points: number, leading?: number): string {
  if (uiScale() === 1) return plain;
  const size = `text-[${scaled(points)}px]`;
  return leading ? `${size} leading-[${scaled(leading)}px]` : size;
}

/** A length class (`h-7`) at the current scale: `prefix-[Npx]` off the default. */
export function sizedBox(plain: string, prefix: string, points: number): string {
  return uiScale() === 1 ? plain : `${prefix}-[${scaled(points)}px]`;
}

/** Text roles (Visual language v2), scaled with the base size. */
export const TEXT = {
  /** Chrome body text: 13pt. */
  get body(): string { return `${TYPE.md} text-foreground`; },
  /** Captions, hints, metadata: 12pt, muted. */
  get caption(): string { return `${TYPE.sm} text-text-secondary`; },
  /** The same size in the foreground. */
  get captionStrong(): string { return `${TYPE.sm} text-foreground`; },
  /** A list row's title: 14pt. */
  get listTitle(): string { return `${TYPE.body} text-foreground`; },
  /** Pane titles: 16pt, semibold. */
  get title(): string { return `${TYPE.lg} text-bright font-semibold`; },
  /** The reader's subject: 20pt, semibold. */
  get subject(): string { return `${TYPE.xl} text-bright font-semibold`; },
  /** Message text: 15pt with 1.6 lines. */
  get message(): string { return `${TYPE.message} text-foreground`; },
  /** A section heading in settings and menus: caption size, muted, sentence case. */
  get section(): string { return `${TYPE.sm} text-text-secondary font-medium`; },
  secondary: "text-text-secondary",
  faint: "text-text-faint",
  bright: "text-bright",
  /** Key caps, times, counts and versions. */
  mono: "font-mono tabular-nums",
  danger: "text-danger",
  warning: "text-warning",
  success: "text-success",
  accent: "text-primary",
};

/** The one radius token: 2pt, controls, panels and popups. */
export const RADIUS = "rounded-(--radius)";

/** Control heights, after nsh-omarchy's `ControlSize`; all scale with the base size. */
export type Size = "small" | "medium" | "large";
export const HEIGHT: Record<Size, string> = {
  get small() { return sizedBox("h-[26px]", "h", 26); },
  get medium() { return sizedBox("h-[30px]", "h", 30); },
  get large() { return sizedBox("h-[34px]", "h", 34); },
};
export const SQUARE: Record<Size, string> = {
  get small() { return sizedBox("size-[26px]", "size", 26); },
  get medium() { return sizedBox("size-[30px]", "size", 30); },
  get large() { return sizedBox("size-[34px]", "size", 34); },
};
/** Control heights in points at base 14. */
export const HEIGHT_PT: Record<Size, number> = { small: 26, medium: 30, large: 34 };
/** Glyph sizes at base 14; `Icon` scales the size it is given. */
export const ICON_SIZE: Record<Size, number> = { small: 14, medium: 16, large: 16 };
export const PAD_X: Record<Size, string> = {
  get small() { return sizedBox("px-2", "px", 8); },
  get medium() { return sizedBox("px-3", "px", 12); },
  get large() { return sizedBox("px-3.5", "px", 14); },
};
export const TEXT_SIZE: Record<Size, string> = {
  get small() { return TYPE.sm; },
  get medium() { return TYPE.md; },
  get large() { return TYPE.body; },
};

/** Status tones a component can take: never the only sign, always with an icon or word. */
export type Tone = "info" | "success" | "warning" | "danger";
export const TONE_TEXT: Record<Tone, string> = {
  info: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

// Spacing utilities on Tailwind's 4pt scale (`px-2`, `gap-1.5`, `h-7`,
// `-mt-1`, `hover:p-1`): what `cx` draws larger with the base size, as the
// Qt client's `Style.space` did. Arbitrary values (`py-[7px]`) and other
// utilities pass through.
const SPACING =
  /(^|\s)((?:[a-z-]+:)*)(-?)(p|px|py|ps|pe|pt|pr|pb|pl|m|mx|my|ms|me|mt|mr|mb|ml|gap|gap-x|gap-y|top|right|bottom|left|start|end|inset|inset-x|inset-y|w|h|size|min-w|min-h|max-w|max-h|basis)-(\d+(?:\.\d+)?)(?=\s|$)/g;

/** Spacing utilities in `classes` at the current scale (reactive); unchanged at base 14. */
export function scaleSpacing(classes: string): string {
  if (uiScale() === 1) return classes;
  return classes.replace(
    SPACING,
    (_m, lead: string, variants: string, neg: string, prefix: string, n: string) =>
      `${lead}${variants}${neg}${prefix}-[${scaled(Number(n) * 4)}px]`,
  );
}

/**
 * Joins class lists, dropping the empty ones, with their spacing at the
 * base size's scale (`scaleSpacing`): in a binding it follows a change.
 */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return scaleSpacing(parts.filter(Boolean).join(" "));
}
