// A multiline plain-text editor for long writing (a message body, an event's
// description), on nsh/base Input. nsh-omarchy's Textarea has a fixed look
// and no paste report or content size, which a message body needs: pasted
// files become attachments, and the field grows with its text so the page
// scrolls rather than a box inside it.
//
// The look is a control's: the control border at rest, the accent while
// focused, the secondary color for the placeholder.
import { signal, type InputRef, type PasteEvent } from "nsh";
import { Input } from "nsh/base";
import { trackTextField, type CompositionEvent } from "./ime";
import { CLASS } from "./motion";
import { cx, LINE, RADIUS, TYPE } from "./tokens";

export interface TextEditorProps {
  /** What screen readers call it ("Message"). */
  label: string;
  value: string;
  placeholder?: string;
  /** The text changed. Controlled: write it back as `value`. */
  onChange: (value: string) => void;
  /** Something was pasted. The text goes in as usual; files and images arrive here only. */
  onPaste?: (e: PasteEvent) => void;
  /** The largest pasted file read, in bytes; larger ones arrive in `tooLarge`, unread. */
  pasteMaxSize?: number;
  /** The smallest height, in points (default 120); it grows with its text from there. */
  minHeight?: number;
  /** `body` (default) 16pt; `message` 15pt on 24pt lines (`TYPE.message`, a message body); `compact` 13pt for a form's notes. */
  size?: "body" | "message" | "compact";
  readonly?: boolean;
  invalid?: boolean;
  /** An input method's composition started, changed or ended (`imeComposing()` reports it app-wide). */
  onCompositionChange?: (e: CompositionEvent) => void;
  /** It took the keyboard focus. */
  onFocus?: () => void;
  /** It lost the keyboard focus. */
  onBlur?: () => void;
  /** Its input, for `focus()` and `insertText()`. */
  inputRef?: (ref: InputRef) => void;
  /** Takes the focus when it appears (a reply opens in its body). */
  autoFocus?: boolean;
  testID?: string;
}

export function TextEditor(props: TextEditorProps) {
  const content = signal(0);
  const ime = trackTextField(() => props.onCompositionChange);
  const height = () => Math.max(props.minHeight ?? 120, content());
  return (
    <Input
      ref={(node) => props.inputRef?.(node)}
      autoFocus={!!props.autoFocus}
      testID={props.testID}
      multiline
      submitBehavior="newline"
      accessibilityLabel={props.label}
      placeholder={ime.composing() ? undefined : props.placeholder}
      value={props.value}
      readonly={!!props.readonly}
      pasteMaxSize={props.pasteMaxSize}
      onChange={(e) => props.onChange(e.value)}
      onPaste={props.onPaste ? (e) => props.onPaste!(e) : undefined}
      onCompositionChange={(e) => ime.onCompositionChange(e)}
      onFocus={() => {
        ime.onFocus();
        props.onFocus?.();
      }}
      onBlur={() => {
        ime.onBlur();
        props.onBlur?.();
      }}
      onContentSizeChange={(e) => content.set(Math.ceil(e.size.height) + 16)}
      style={{ height: height() }}
      class={cx(
        "px-3 py-2 bg-background text-foreground placeholder:text-text-secondary",
        props.size === "compact" ? TYPE.md : props.size === "message" ? TYPE.message : TYPE.lg,
        RADIUS,
        props.invalid ? LINE.danger : LINE.control,
        "hover:border-rule-strong", LINE.inputFocus,
        CLASS.wash,
      )}
    />
  );
}
