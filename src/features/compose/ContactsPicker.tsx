// The contact book as a popover from the To line: search, then put a contact
// on To, Cc or Bcc. Port of ContactsPicker.qml. The trigger stays selected
// while the popover is open; Escape closes it and gives the keyboard back.
import { computed, signal, Text, View } from "nsh";
import { Input, Popover, ScrollBox, ToolButton, cx, TEXT } from "../../ui";
import * as Recipients from "../../mail/compose/recipients";
import type { Contact } from "../../mail/compose/recipients";
import { addContact, compose, refreshContacts } from "./store";

const LIMIT = 100;

export function ContactsPicker() {
  const open = signal(false);
  const query = signal("");
  const rows = computed<Contact[]>(() => Recipients.filter(compose.contacts(), query(), LIMIT));
  const label = computed(() => `Contacts (${compose.contacts().length})`);

  return (
    <Popover
      open={open()}
      placement="bottom"
      align="end"
      width={340}
      onOpenChange={(e) => {
        open.set(e.open);
        if (e.open) refreshContacts();
        else query.set("");
      }}
      trigger={<ToolButton testID="compose-contacts" label={label()} icon="people" iconOnly selected={open()} />}
    >
      {/* The popover sets the width; the list is as tall as its rows, up to 300pt. */}
      <View class="w-full gap-2">
        <Input
          testID="compose-contacts-search"
          autoFocus
          value={query()}
          placeholder="Search contacts..."
          accessibilityLabel="Search contacts"
          onChange={(e) => query.set(e.value)}
        />
        <If when={rows().length === 0}>
          <Text class={cx(TEXT.caption, "px-1 py-2")}>No contacts found</Text>
        </If>
        <ScrollBox maxHeight={300}>
          <Each of={rows()} key="index">
            {(contact, index) => (
              <View testID={`contact-${index()}`} class="flex-row items-center gap-2 py-1">
                <View class="flex-1 min-w-0">
                  <Text class={cx(TEXT.body, "line-clamp-1")}>{contact().name || contact().email}</Text>
                  <If when={!!contact().name}>
                    <Text class={cx(TEXT.caption, "line-clamp-1")}>{contact().email}</Text>
                  </If>
                </View>
                <ToolButton label="+ To" onPress={() => addContact("to", contact())} />
                <ToolButton label="+ Cc" onPress={() => addContact("cc", contact())} />
                <ToolButton label="+ Bcc" onPress={() => addContact("bcc", contact())} />
              </View>
            )}
          </Each>
        </ScrollBox>
      </View>
    </Popover>
  );
}
