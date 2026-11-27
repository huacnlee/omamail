// nsh-omarchy's controls (their behavior: icons, loading, tooltips, refs,
// groups) drawn in Visual language v2's look at Omarchy's base size. A class
// on the control's host is drawn over nsh-omarchy's Rust look (colors, state
// colors and sizes alike), so each wrapper passes its look as classes, sizes
// scaled by `uiScale()`. Every prop and the ref pass through unchanged
// (`split` keeps them live); a caller's own `class` comes last and wins.
//
// What a host class cannot reach stays at base 14: glyphs, and text a
// control sizes on its own children. Checkbox and Switch are the ui layer's
// own (Toggles.tsx), so their box and track scale; TitleBar's title is drawn
// here for the same reason.
// Menus, Field, the dialogs and Select are the ui layer's own (Menu.tsx,
// Field.tsx, Dialog.tsx, Select.tsx), so their text follows the base size.
//
// Input, Textarea and NumberInput are named by the label of the `Field`
// around them when they have no `accessibilityLabel` of their own, as
// nsh-omarchy's are by its Field.
import { signal, split, Text, type InputRef as BaseInputRef } from "nsh";
import { Input as BaseInput } from "nsh/base";
import {
  Button as OmButton,
  IconButton as OmIconButton,
  Input as OmInput,
  type InputRef as OmInputRef,
  NumberInput as OmNumberInput,
  Textarea as OmTextarea,
  ListItem as OmListItem,
  TitleBar as OmTitleBar,
} from "nsh-omarchy";
import { scaled, uiScale } from "./font";
import { FieldLabel } from "./Field";
import { trackTextField, type CompositionEvent } from "./ime";
import { cx, FILL, HEIGHT_PT, RING, SELECTED_TEXT } from "./tokens";
import { TitleBandContext } from "./titleBand";

type ControlSize = "small" | "medium" | "large";
type Variant = "default" | "primary" | "ghost" | "danger";
const HEIGHT: Record<ControlSize, number> = HEIGHT_PT;
const PADDING: Record<ControlSize, number> = { small: 8, medium: 12, large: 14 };
const GAP: Record<ControlSize, number> = { small: 6, medium: 8, large: 8 };
const TEXT: Record<ControlSize, number> = { small: 12, medium: 13, large: 14 };

/** `prefix-[Npx]` for each pair, at the current scale (reactive). */
function sized(pairs: [string, number][]): string {
  return pairs.map(([prefix, points]) => `${prefix}-[${scaled(points)}px]`).join(" ");
}

/**
 * A control's height class at the current scale, in whole points: a half
 * point lands on a different pixel edge per row, so fields and selects side
 * by side would differ by one.
 */
export function controlHeight(size: ControlSize): string {
  return `h-[${Math.round(scaled(HEIGHT[size]))}px]`;
}

function sizeOf(size: ControlSize | null | undefined): ControlSize {
  return size ?? "medium";
}

/**
 * A button's colors by variant (Visual language v2): primary is filled
 * primary; default is a bordered control; ghost is text that fills
 * `surface-raised` on hover; danger is danger text, filled only where it
 * confirms (`confirm`). Selected is the selection fill; focus a 1pt border.
 */
function variantClass(variant: Variant, confirm: boolean): string {
  switch (variant) {
    case "primary":
      return "bg-primary border-primary text-primary-foreground hover:bg-primary-hover hover:border-primary-hover active:bg-primary-hover focus-visible:border-foreground selected:bg-primary-hover";
    case "danger":
      return confirm
        ? "bg-danger border-danger text-primary-foreground hover:opacity-90 active:opacity-80 focus-visible:border-foreground"
        : "bg-transparent border-transparent text-danger hover:bg-surface-raised active:bg-selection focus-visible:border-primary selected:bg-selection";
    case "ghost":
      return "bg-transparent border-transparent text-foreground hover:bg-surface-raised active:bg-selection focus-visible:border-primary selected:bg-selection";
    default:
      return "bg-transparent border-border text-foreground hover:bg-surface-raised hover:border-rule-strong active:bg-selection focus-visible:border-primary selected:bg-selection";
  }
}

/**
 * nsh-omarchy's button is `self-start`, which beats a row's `items-center`
 * (a small button beside taller controls sat on their top edge). `self-auto`
 * leaves the cross axis to the parent; `w-fit` keeps the button hugging its
 * label in a column, unless the caller sizes its width.
 */
function hugClass(callerClass: string | undefined): string {
  return /(^|\s)(w-|flex-1|self-stretch|min-w-full|grow)/.test(callerClass ?? "") ? "self-auto" : "self-auto w-fit";
}

const BUTTON_BASE = "rounded-(--radius) transition-colors duration-[120ms] ease-out disabled:opacity-40 motion-reduce:transition-none";

type Props<C> = C extends (props: infer P) => unknown ? P : never;

export type ButtonProps = Props<typeof OmButton> & {
  /** A danger button that confirms (a dialog's destructive action): filled danger. */
  confirm?: boolean;
};
/** A button (nsh-omarchy's behavior: icon, loading, tooltip, group), drawn in v2's look at the base size. */
export function Button(props: ButtonProps) {
  const [own, rest] = split(props, ["class", "confirm"]);
  const look = () => {
    const s = sizeOf(rest.size);
    return cx(
      BUTTON_BASE,
      hugClass(own.class),
      variantClass(rest.variant ?? "default", own.confirm === true),
      controlHeight(s),
      sized([["px", PADDING[s]], ["gap", GAP[s]], ["text", TEXT[s]]]),
    );
  };
  return <OmButton {...rest} class={cx(look(), own.class ?? "")} />;
}

export type IconButtonProps = Props<typeof OmIconButton>;
/** A square icon button (ghost by default), 26 / 30 / 34 at base 14. */
export function IconButton(props: IconButtonProps) {
  const [own, rest] = split(props, ["class"]);
  const look = () => {
    const s = sizeOf(rest.size);
    return cx(BUTTON_BASE, "self-auto", variantClass(rest.variant ?? "ghost", false), controlHeight(s), `w-[${Math.round(scaled(HEIGHT[s]))}px]`);
  };
  return <OmIconButton {...rest} class={cx(look(), own.class ?? "")} />;
}

/** A field's frame: background, a hairline that strengthens under the pointer, primary while it edits. */
function fieldClass(invalid: boolean | undefined): string {
  return cx(
    "rounded-(--radius) bg-background text-foreground transition-colors duration-[120ms] ease-out motion-reduce:transition-none",
    invalid
      ? "border-danger hover:border-danger focus:border-danger"
      : "border-border hover:bg-background hover:border-rule-strong focus:bg-background focus:border-primary",
    "disabled:opacity-50",
  );
}

/** Om's ref shape (`node`, `focus`, `blur`, `setSelection`, `insertText`) over an nsh/base Input's ref. */
function inputRefOf(node: BaseInputRef): OmInputRef {
  return {
    node,
    focus: () => node.focus(),
    blur: () => node.blur(),
    setSelection: (start, end) => node.setSelection(start, end ?? undefined),
    insertText: (text) => node.insertText(text),
  };
}

/** The props the ui text fields add to nsh-omarchy's: the input method and the focus. */
interface TextFieldEvents {
  /**
   * An input method's composition started, changed or ended (pinyin before
   * a character is chosen). The field already ignores Return while it is
   * open, and `imeComposing()` reports it app-wide.
   */
  onCompositionChange?: (e: CompositionEvent) => void;
  /** It took the keyboard focus. */
  onFocus?: () => void;
  /** It lost the keyboard focus. */
  onBlur?: () => void;
}

const FIELD_KEYS = [
  "class", "ref", "size", "invalid", "masked", "disabled", "readonly", "placeholder",
  "accessibilityLabel", "onChange", "onSubmit", "onCompositionChange", "onFocus", "onBlur", "value", "autoFocus",
] as const;

/** A plain field: the frame around it draws the border and the focus. */
const PLAIN_FIELD = "rounded-(--radius) bg-transparent text-foreground border border-transparent disabled:opacity-50";

export type InputProps = Props<typeof OmInput> &
  TextFieldEvents & {
    /**
     * `default`: a field with its own border. `plain`: no border and no fill,
     * at the same height and padding, for a field inside a frame that draws
     * its focus (a `FinderPanel` with `focusWithin`).
     */
    variant?: "default" | "plain";
  };
/**
 * A text field: 30 tall (26 / 34), 12pt sides, 13pt text, at the base size.
 * Built on nsh/base's Input (nsh-omarchy's has no composition events): while
 * an input method composes, Return chooses its candidate and never reaches
 * `onSubmit`, and the placeholder stays hidden under the composed text.
 */
export function Input(props: InputProps) {
  const [own, rest] = split(props, [...FIELD_KEYS, "variant"]);
  const ime = trackTextField(() => own.onCompositionChange);
  const look = () => {
    const s = sizeOf(own.size);
    const frame = own.variant === "plain" ? PLAIN_FIELD : cx(fieldClass(own.invalid), "border");
    return cx(frame, "placeholder:text-text-secondary selection:bg-selection", controlHeight(s), sized([["px", PADDING[s]], ["text", TEXT[s]]]));
  };
  const field = FieldLabel();
  return (
    <BaseInput
      {...rest}
      ref={(node: BaseInputRef) => {
        if (typeof own.ref === "function") own.ref(inputRefOf(node));
      }}
      value={own.value}
      autoFocus={own.autoFocus}
      masked={own.masked}
      readonly={!!own.readonly || !!own.disabled}
      disabled={own.disabled}
      focusable={own.disabled ? false : undefined}
      placeholder={ime.composing() ? undefined : (own.placeholder ?? undefined)}
      accessibilityLabel={own.accessibilityLabel ?? field?.() ?? undefined}
      accessibilityState={own.invalid ? { invalid: true } : undefined}
      submitBehavior="submit"
      onChange={(e) => own.onChange?.({ value: e.value })}
      onSubmit={(e) => {
        if (ime.composing()) return;
        own.onSubmit?.({ value: e.text });
      }}
      onCompositionChange={(e) => ime.onCompositionChange(e)}
      onFocus={() => {
        ime.onFocus();
        own.onFocus?.();
      }}
      onBlur={() => {
        ime.onBlur();
        own.onBlur?.();
      }}
      class={cx(look(), own.class ?? "")}
    />
  );
}

export type TextareaProps = Props<typeof OmTextarea> & TextFieldEvents;
/**
 * A multi-line field: 20pt lines, 12pt sides, 13pt text, at the base size;
 * `rows` lines tall, growing with its text. Return types a new line (an
 * input method's Return chooses its candidate). Built on nsh/base's Input
 * for its composition events.
 */
export function Textarea(props: TextareaProps) {
  const [own, rest] = split(props, [
    "class", "ref", "invalid", "disabled", "readonly", "placeholder", "accessibilityLabel",
    "onChange", "onCompositionChange", "onFocus", "onBlur", "value", "rows",
  ]);
  const ime = trackTextField(() => own.onCompositionChange);
  const content = signal(0);
  const look = () =>
    cx(fieldClass(own.invalid), "border placeholder:text-text-secondary selection:bg-selection", sized([["px", 12], ["py", 6], ["text", 13]]));
  const field = FieldLabel();
  return (
    <BaseInput
      {...rest}
      ref={(node: BaseInputRef) => {
        if (typeof own.ref === "function") own.ref(inputRefOf(node));
      }}
      multiline
      submitBehavior="newline"
      value={own.value}
      readonly={!!own.readonly || !!own.disabled}
      disabled={own.disabled}
      focusable={own.disabled ? false : undefined}
      placeholder={ime.composing() ? undefined : (own.placeholder ?? undefined)}
      accessibilityLabel={own.accessibilityLabel ?? field?.() ?? undefined}
      accessibilityState={own.invalid ? { invalid: true } : undefined}
      onChange={(e) => own.onChange?.({ value: e.value })}
      onCompositionChange={(e) => ime.onCompositionChange(e)}
      onContentSizeChange={(e) => content.set(Math.ceil(e.size.height))}
      onFocus={() => {
        ime.onFocus();
        own.onFocus?.();
      }}
      onBlur={() => {
        ime.onBlur();
        own.onBlur?.();
      }}
      style={{ height: Math.max(scaled(12 + 20 * (own.rows ?? 4)), content() + scaled(12)) }}
      class={cx(look(), own.class ?? "")}
    />
  );
}

export type NumberInputProps = Props<typeof OmNumberInput>;
/** A number field with its step buttons: 30 tall, 13pt text, at the base size. */
export function NumberInput(props: NumberInputProps) {
  const [own, rest] = split(props, ["class"]);
  const look = () =>
    cx(
      "rounded-(--radius) bg-background text-foreground",
      rest.invalid ? "border-danger" : "border-border hover:bg-background hover:border-rule-strong focus-within:bg-background focus-within:border-primary",
      controlHeight("medium"),
      sized([["w", 144], ["text", 13]]),
    );
  const field = FieldLabel();
  return <OmNumberInput {...rest} accessibilityLabel={rest.accessibilityLabel ?? field?.() ?? null} class={cx(look(), own.class ?? "")} />;
}

export type ListItemProps = Props<typeof OmListItem>;
/**
 * A list's row (nsh-omarchy's behavior), 30 tall: hover `surface-raised`;
 * selected the selection fill with bright semibold text; the keyboard's
 * focus a 1pt primary ring inset on the row. Selected wins over hover.
 */
export function ListItem(props: ListItemProps) {
  const [own, rest] = split(props, ["class"]);
  const look = () =>
    cx(
      "rounded-none text-foreground",
      RING.rest,
      rest.selected ? cx(FILL.selected, SELECTED_TEXT, "hover:bg-selection") : cx("bg-transparent", FILL.hover),
      FILL.pressed,
      RING.focus,
      controlHeight("medium"),
      sized([["px", 12], ["gap", 8]]),
    );
  return <OmListItem {...rest} class={cx(look(), own.class ?? "")} />;
}

export type TitleBarProps = Props<typeof OmTitleBar>;
/**
 * nsh-omarchy's TitleBar with its title drawn here, 12pt semibold bright
 * text at the base size (the library's own title is fixed at 12). The bar's
 * height is the window's title bar option, which stays nsh-omarchy's 36.
 */
export function TitleBar(props: TitleBarProps) {
  const [own, rest] = split(props, ["title", "children"]);
  return (
    <OmTitleBar {...rest} title={null}>
      <If when={own.title != null && own.title !== ""}>
        <Text class={cx(uiScale() === 1 ? "text-[12px]" : `text-[${scaled(12)}px]`, "font-semibold text-bright")}>{own.title}</Text>
      </If>
      <TitleBandContext.Provider value={true}>{own.children}</TitleBandContext.Provider>
    </OmTitleBar>
  );
}
