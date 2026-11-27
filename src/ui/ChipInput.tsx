// A field of tokens with a text input at its end: the recipients of a
// message, the labels of a filter. The tokens are the caller's (a draft's
// recipients are the draft's); the field turns typing into requests:
// `onCommit` when Return or a comma ends an entry, `onRemove` when a token's
// remove button is pressed or Backspace is pressed in the empty input.
// While an input method composes, Return and Backspace are its own.
//
// A token says it is invalid in words ("Invalid address" on its remove
// button's name and a warning glyph), not only by its border's color.
import { signal, Text, View, type InputRef } from "nsh";
import { Button as BaseButton, Input } from "nsh/base";
import { Tooltip as OmTooltip } from "./Tooltip";
import { Icon } from "./Icon";
import { trackTextField, type CompositionEvent } from "./ime";
import { CLASS } from "./motion";
import { cx, FILL, LINE, RADIUS, TEXT, TYPE, sizedBox } from "./tokens";

export interface ChipToken {
  /** Stable across edits: the token keeps its view while others come and go. */
  id: string;
  /** What the token shows (a name, else the address). Plain text: it comes from mail. */
  label: string;
  /** The rest, for its tooltip (the address behind a name). */
  detail?: string;
  /** Not usable as it is (an address that does not parse): a warning glyph and a danger border. */
  invalid?: boolean;
}

/** Where the typed text ends an entry: Return, a comma or a semicolon. */
export function splitEntries(text: string): { entries: string[]; rest: string } {
  const parts = text.split(/[,;]/);
  const rest = parts.pop() ?? "";
  return { entries: parts.map((p) => p.trim()).filter((p) => p !== ""), rest };
}

/**
 * What a change to the field's text commits: while an input method composes
 * (pinyin, which the macOS adapter passes through onChange), nothing, so a
 * separator the method has not committed stays in the text; else
 * `splitEntries`.
 */
export function entriesOnChange(text: string, composing: boolean): { entries: string[]; rest: string } {
  return composing ? { entries: [], rest: text } : splitEntries(text);
}

export interface ChipInputProps {
  /** What the field is ("To"): its screen reader name and its leading caption. */
  label: string;
  /** Show `label` as a caption before the tokens (default true). */
  showLabel?: boolean;
  tokens: readonly ChipToken[];
  /** The text being typed. Controlled: write `onChange`'s value back. */
  value: string;
  placeholder?: string;
  disabled?: boolean;
  /** The text changed. Separators are taken out first and reach `onCommit`. */
  onChange: (value: string) => void;
  /** An entry ended (Return, a comma, a semicolon, or a paste of several): add it as a token. */
  onCommit: (text: string) => void;
  /** Remove this token. */
  onRemove: (id: string) => void;
  /** Return in an empty input: the field has nothing to commit (a form's submit). */
  onSubmitEmpty?: () => void;
  /** An input method's composition started, changed or ended. Return and Backspace belong to it while it is open. */
  onCompositionChange?: (e: CompositionEvent) => void;
  /** A focused field draws the accent border. */
  onFocusChange?: (focused: boolean) => void;
  /** The input takes the focus when the field appears (a new message lands in To). */
  autoFocus?: boolean;
  /** Its text input, for `focus()` (and `insertText()` / `setSelection()`). */
  inputRef?: (ref: InputRef) => void;
  testID?: string;
}

export function ChipInput(props: ChipInputProps) {
  let input: InputRef | undefined;
  const focused = signal(false);
  const ime = trackTextField(() => props.onCompositionChange);

  const change = (value: string) => {
    const { entries, rest } = entriesOnChange(value, ime.composing());
    for (const entry of entries) props.onCommit(entry);
    props.onChange(rest);
  };
  const submit = (text: string) => {
    // Return while composing chooses the input method's candidate.
    if (ime.composing()) return;
    const trimmed = text.trim();
    if (trimmed === "") {
      props.onSubmitEmpty?.();
      return;
    }
    props.onCommit(trimmed);
    props.onChange("");
  };

  return (
    <View
      testID={props.testID}
      onPress={() => input?.focus()}
      class={cx(
        sizedBox("min-h-[30px]", "min-h", 30), "flex-row flex-wrap items-center gap-1 px-2 py-[4px] bg-background",
        RADIUS,
        "border",
        focused() ? "border-primary" : "border-border hover:border-rule-strong",
        props.disabled ? "opacity-40" : "",
        CLASS.wash,
      )}
    >
      <If when={props.showLabel !== false}>
        <Text class={cx(TEXT.caption, "pl-1 pr-1")}>{props.label}</Text>
      </If>
      <Each of={props.tokens} key={(t) => t.id}>
        {(token) => (
          <ChipTokenView token={token()} disabled={!!props.disabled} onRemove={() => props.onRemove(token().id)} />
        )}
      </Each>
      <Input
        ref={(node) => {
          input = node;
          props.inputRef?.(node);
        }}
        autoFocus={!!props.autoFocus}
        accessibilityLabel={props.label}
        value={props.value}
        placeholder={props.tokens.length === 0 && !ime.composing() ? props.placeholder : undefined}
        readonly={!!props.disabled}
        submitBehavior="submit"
        autoCapitalize="none"
        autoCorrect={false}
        onChange={(e) => change(e.value)}
        onSubmit={(e) => submit(e.text)}
        onKeyPress={(e) => {
          if (e.key === "Backspace" && !ime.composing() && props.value === "" && props.tokens.length > 0) {
            props.onRemove(props.tokens[props.tokens.length - 1]!.id);
          }
        }}
        onCompositionChange={(e) => {
          const was = ime.composing();
          ime.onCompositionChange(e);
          // Ended: what it committed may now hold separators.
          if (was && !e.composing) change(props.value);
        }}
        onFocus={() => {
          ime.onFocus();
          focused.set(true);
          props.onFocusChange?.(true);
        }}
        onBlur={() => {
          ime.onBlur();
          focused.set(false);
          props.onFocusChange?.(false);
        }}
        class={cx(sizedBox("h-5", "h", 20), "min-w-[80px] flex-1 bg-transparent px-1 text-foreground placeholder:text-text-secondary", TYPE.md)}
      />
    </View>
  );
}

/** One token: its label, and a remove button that says what it removes. */
export function ChipTokenView(props: { token: ChipToken; disabled?: boolean; onRemove: () => void; testID?: string }) {
  const removeLabel = () =>
    props.token.invalid ? `Remove ${props.token.label} (invalid address)` : `Remove ${props.token.label}`;
  return (
    <View
      testID={props.testID ?? `token-${props.token.id}`}
      tooltip={props.token.detail ? <OmTooltip label={props.token.detail} /> : undefined}
      class={cx(
        "h-5 flex-row items-center gap-1 pl-1.5 pr-0.5",
        RADIUS,
        FILL.raised,
        props.token.invalid ? LINE.danger : LINE.border,
      )}
    >
      <If when={props.token.invalid}>
        <Icon name="warning" size={12} class="text-danger" label="Invalid address" />
      </If>
      <Text class={cx(TYPE.md, "text-foreground line-clamp-1")}>{props.token.label}</Text>
      <BaseButton
        accessibilityLabel={removeLabel()}
        disabled={!!props.disabled}
        onPress={() => props.onRemove()}
        hitSlop={4}
        class={cx(
          "size-4 items-center justify-center text-text-secondary hover:text-foreground",
          RADIUS,
          FILL.hover,
          FILL.pressed,
          LINE.clear,
          LINE.focus,
          CLASS.pressIcon,
        )}
      >
        <Icon name="close" size={12} />
      </BaseButton>
    </View>
  );
}
