// Input method composition across the ui layer's text fields. A user typing
// pinyin, kana or hangul composes text in a field before committing it: while
// that composition is open, Return chooses a candidate and Escape cancels the
// composition. They do not submit the field, and they do not reach the
// app's shortcuts. Every ui text field (Input, Textarea, ChipInput,
// TextEditor, Select's search) reports its composition here, and the shell's
// key router gates on `imeComposing()`.
//
// One global signal: a set of the fields composing now. A field leaves it when
// its composition ends, when it loses the focus, and when it unmounts, so a
// field removed mid-composition (a dialog closed by the pointer) can never
// leave the app's keys switched off.
import { cleanup, signal } from "nsh";

const composingFields = signal<ReadonlySet<number>>(new Set());
const focusedFields = signal<ReadonlySet<number>>(new Set());
let nextField = 0;

function withId(set: ReadonlySet<number>, id: number, on: boolean): ReadonlySet<number> {
  if (set.has(id) === on) return set;
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/**
 * Whether an input method's composition is open in any ui text field
 * (reactive). While it is, Return, Escape, Tab and the arrows belong to the
 * input method, so the shell's router binds no shortcuts.
 */
export function imeComposing(): boolean {
  return composingFields().size > 0;
}

/**
 * Whether a ui text field has the keyboard focus or is composing (reactive):
 * single-letter shortcuts stand aside while it is true, because the letters
 * are being typed.
 */
export function textInputActive(): boolean {
  return focusedFields().size > 0 || composingFields().size > 0;
}

/** What `onCompositionChange` reports. */
export interface CompositionEvent {
  composing: boolean;
  text: string;
}

/** One text field's part in the global state: wire its handlers to the field's Input. */
export interface TextFieldIme {
  /** This field is composing now (reactive): it ignores Return and separators, and hides its placeholder. */
  composing(): boolean;
  /** For the Input's `onCompositionChange`: tracks it, then calls the caller's own handler. */
  onCompositionChange(e: CompositionEvent): void;
  /** For the Input's `onFocus`. */
  onFocus(): void;
  /** For the Input's `onBlur`: a field that loses the focus is no longer composing. */
  onBlur(): void;
}

/**
 * A text field's composition tracker. Call it once in the field's component
 * body: it leaves the global state when the component goes away.
 * `forward` is the caller's own `onCompositionChange`.
 */
export function trackTextField(forward?: () => ((e: CompositionEvent) => void) | undefined): TextFieldIme {
  const id = nextField++;
  const mine = signal(false);
  const setComposing = (on: boolean) => {
    mine.set(on);
    composingFields.update((set) => withId(set, id, on));
  };
  cleanup(() => {
    composingFields.update((set) => withId(set, id, false));
    focusedFields.update((set) => withId(set, id, false));
  });
  return {
    composing: () => mine(),
    onCompositionChange: (e) => {
      setComposing(e.composing);
      forward?.()?.(e);
    },
    onFocus: () => focusedFields.update((set) => withId(set, id, true)),
    onBlur: () => {
      focusedFields.update((set) => withId(set, id, false));
      if (mine()) {
        setComposing(false);
        forward?.()?.({ composing: false, text: "" });
      }
    },
  };
}
