// One recipient line (To, Cc, Bcc, Reply-To): the addresses as chips, the
// text being typed after them, and the contact book's matches under it while
// the field has the keyboard. Port of ComposeView's recipient rows and
// RecipientSuggestions.qml.
//
// The draft keeps each line as one address list ("Ann <a@x>, b@y, typ"): the
// chips are its finished entries and the input shows what follows the last
// separator, so recovery and the send see exactly what the user sees.
// Names and addresses come from mail: they are shown as plain text.
import { computed, signal, Text, View, type InputRef } from "nsh";
import { ChipInput, cx, FILL, LINE, PickerRow, RADIUS, type ChipToken } from "../../ui";
import * as Recipients from "../../mail/compose/recipients";
import type { Contact } from "../../mail/compose/recipients";
import { registerEscape } from "../../keys/commands";
import { compose } from "./store";

export interface RecipientFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Return in the empty input moves on (to Subject). */
  onSubmitEmpty?: () => void;
  /** Take the keyboard when it appears (To on a new message). */
  autoFocus?: boolean;
  /** Its input, for moving the keyboard to it. */
  inputRef?: (ref: InputRef) => void;
  testID?: string;
}

function head(text: string): string {
  const { done } = Recipients.tokens(text);
  return done.length === 0 ? "" : done.map((t) => t.text).join(", ") + ", ";
}

export function RecipientField(props: RecipientFieldProps) {
  const focused = signal(false);
  const cursor = signal(0);
  /** Escape hid the matches for this text; typing brings them back. */
  const dismissed = signal<string | null>(null);
  const parsed = computed(() => Recipients.tokens(props.value));
  const chips = computed<ChipToken[]>(() =>
    parsed().done.map((t, i) => ({
      id: `${i}:${t.text}`,
      label: t.label || t.text,
      detail: t.email && t.label !== t.email ? t.email : undefined,
      invalid: t.invalid,
    })),
  );
  const matches = computed<Contact[]>(() =>
    focused() && dismissed() !== parsed().pending ? compose.suggestions("to", parsed().pending) : [],
  );
  // Escape closes the matches first, before compose's own Back.
  registerEscape(() => {
    if (matches().length === 0) return false;
    dismissed.set(parsed().pending);
    return true;
  });

  // A chosen contact is a chip at once (the Qt field kept it as text to edit
  // on; here the line is chips, and a chip is removed or replaced whole).
  const choose = (contact: Contact) => {
    props.onChange(Recipients.accept(props.value, contact) + ", ");
    cursor.set(0);
  };

  return (
    <View class="flex-1 gap-1">
      <ChipInput
        testID={props.testID}
        label={props.label}
        showLabel={false}
        autoFocus={props.autoFocus}
        inputRef={(ref) => props.inputRef?.(ref)}
        tokens={chips()}
        value={parsed().pending}
        onChange={(rest) => {
          props.onChange(head(props.value) + rest);
          cursor.set(0);
        }}
        onCommit={(entry) => {
          // A typed name that matches one contact takes its address.
          const list = matches();
          if (list.length > 0 && cursor() < list.length && Recipients.currentToken(props.value).trim() === entry.trim()) {
            choose(list[cursor()]!);
            return;
          }
          props.onChange(head(props.value) + entry + ", ");
        }}
        onRemove={(id) => {
          const index = chips().findIndex((c) => c.id === id);
          if (index >= 0) props.onChange(Recipients.removeToken(props.value, index));
        }}
        onSubmitEmpty={() => props.onSubmitEmpty?.()}
        onFocusChange={(f) => {
          // Let a press on a suggestion land before the list goes.
          if (f) focused.set(true);
          else setTimeout(() => focused.set(false), 150);
        }}
      />
      <If when={matches().length > 0}>
        <View
          role="list"
          accessibilityLabel={`Suggestions for ${props.label}`}
          class={cx("py-1", RADIUS, LINE.border, FILL.surface)}
        >
          <Each of={matches()} key="index">
            {(contact, index) => (
              <PickerRow
                testID={`${props.testID ?? "recipient"}-suggestion-${index()}`}
                label={contact().name || contact().email}
                detail={contact().name ? contact().email : undefined}
                cursor={index() === cursor()}
                onPress={() => choose(contact())}
              />
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
