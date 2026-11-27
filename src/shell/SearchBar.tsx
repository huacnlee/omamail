// The header's search field. Port of omarchy/ui/components/SearchBar.qml:
// Return runs the query on the open mailbox, the clear button and Escape
// clear it, `/` focuses it, and a spinner says while the server searches.
// Writes `app.search`; the list feature reads `app.query()`.
import { cleanup, effect, signal, Text, untracked, View } from "nsh";
import { app } from "../app/store";
import { keyReport, registerEscape } from "../keys/commands";
import { IconButton, Input, scaled, Spinner, TEXT, Tooltip, cx } from "../ui";

export const SEARCH_PLACEHOLDER = "Search mail — from:jane has:attachment";

// STOPGAP (remove when NSH delivers the press): on macOS a press inside a
// hidden title bar's area never arrives while a text field has the focus;
// no touch or press event reaches the content view, only the pointer's
// enter and moves. So each header button (Header.tsx ReleasesSearch, the
// button itself, not the gaps around it) lets go of the search field when
// the pointer comes over it (and on touch-in elsewhere), and the press that
// follows lands. Only a focused field is released. The cost: pointing at a
// header button while searching takes the keyboard from the field (its text
// stays). NSH issue
// draft: docs/NSH-PORT.md, "NSH issue: title-bar presses lost while a field
// is focused".
let blurActive: (() => void) | null = null;

/** Gives up the search field's focus, if it has it. See the STOPGAP note. */
export function releaseSearchFocus(): void {
  blurActive?.();
}

export function SearchBar() {
  let input: { focus(): void; blur(): void } | undefined;
  blurActive = () => {
    if (app.searchFocused()) input?.blur();
  };
  cleanup(() => {
    blurActive = null;
  });
  const draft = signal(app.query());
  const width = signal(0);

  // A search changed elsewhere (a mailbox switch, Back on the root) shows here,
  // except while the user is typing over it.
  effect(() => {
    const query = app.query();
    untracked(() => {
      if (!app.searchFocused() && draft() !== query) draft.set(query);
    });
  });
  // `/` asks for the focus.
  effect(() => {
    if (app.searchFocusRequests() > 0) untracked(() => input?.focus());
  });

  const clear = () => {
    draft.set("");
    if (app.query() !== "") app.search("");
  };

  // Escape in the field: clear the text if there is any, then give the
  // keyboard back. Registered at mount, so later layers (the assistant's,
  // a calendar preview) are offered Escape first.
  registerEscape(() => {
    if (!app.searchFocused()) return false;
    if (draft() !== "") clear();
    input?.blur();
    app.setSearchFocused(false);
    return true;
  });

  return (
    <View
      class={cx("flex-row items-center gap-1")}
      onLayout={(e) => width.set(e.bounds.size.width)}
      onFocusIn={() => app.setSearchFocused(true)}
      onFocusOut={() => app.setSearchFocused(false)}
    >
      <View class="flex-1">
        <Input
          ref={(r) => (input = r)}
          testID="header-search"
          size="small"
          value={draft()}
          placeholder={SEARCH_PLACEHOLDER}
          accessibilityLabel="Search mail"
          onChange={(e) => draft.set(e.value)}
          onSubmit={(e) => app.search(e.value.trim())}
        />
      </View>
      <If when={keyReport().serverSearching === true}>
        <View class={cx("flex-row items-center gap-1")} accessibilityLabel="Searching server">
          <Spinner size={scaled(12)} />
          <If when={width() >= 260}>
            <Text class={TEXT.caption}>Searching server</Text>
          </If>
        </View>
      </If>
      <If when={draft() !== ""}>
        <IconButton
          icon="x"
          label="Clear search"
          size="small"
          variant="ghost"
          tooltip={<Tooltip label="Clear search · esc" />}
          onPress={clear}
        />
      </If>
    </View>
  );
}
