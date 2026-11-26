import { List, Text, View } from "nsh";
import { Button, EmptyState, Icon, ListItem } from "nsh-omarchy";
import type { ListState } from "./Main";

/** Human words for the backend's error codes the list can show. */
function describe(code: string): string {
  if (code === "no_accounts") return "Add an account in Omamail to read mail here.";
  if (code === "auth_required") return "This account needs to sign in again.";
  return `The mailbox could not be loaded (${code}).`;
}

/** The middle pane: one row per message, newest first. */
export function MessageList(props: {
  state: ListState;
  selected: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  return (
    <View class="w-[380px] border-r border-border">
      <If when={props.state.kind === "loading"}>
        <EmptyState title="Loading" icon="loader-circle" />
      </If>
      <If when={props.state.kind === "error"}>
        <EmptyState
          title="Nothing to show"
          icon="circle-alert"
          description={props.state.kind === "error" ? describe(props.state.code) : ""}
        >
          <Button label="Try again" onPress={props.onRetry} />
        </EmptyState>
      </If>
      <If when={props.state.kind === "page" && props.state.page.messages.length === 0}>
        <EmptyState title="No messages" icon="inbox" />
      </If>
      <If when={props.state.kind === "page" && props.state.page.messages.length > 0}>
        <List
          class="flex-1"
          testID="messages"
          each={props.state.kind === "page" ? props.state.page.messages : []}
          keyExtractor={(m) => m.id}
        >
          {(m) => (
            <ListItem
              class="h-[68px] items-start"
              accessibilityLabel={`${m().from}: ${m().subject}`}
              selected={props.selected === m().id}
              onPress={() => props.onSelect(m().id)}
            >
              <View class="flex-1 gap-0.5 py-1">
                <View class="flex-row items-center gap-2">
                  <View class={`size-1.5 rounded-full ${m().unread ? "bg-accent" : "bg-transparent"}`} />
                  <Text class={`flex-1 truncate ${m().unread ? "font-semibold text-bright" : ""}`}>{m().from}</Text>
                  <If when={m().starred}>
                    <Icon name="star" size={12} class="text-warning" />
                  </If>
                  <Text class="text-[11px] text-text-secondary">{m().time}</Text>
                </View>
                <Text class={`truncate pl-3.5 ${m().unread ? "text-bright" : ""}`}>{m().subject || "(no subject)"}</Text>
                <Text class="truncate pl-3.5 text-[12px] text-text-secondary">{m().snippet}</Text>
              </View>
            </ListItem>
          )}
        </List>
      </If>
    </View>
  );
}
