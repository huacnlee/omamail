import { List, View } from "nsh";
import { Button, EmptyState, Icon, Input, ListItem } from "nsh-omarchy";
import { Body, Caption, Title } from "./ui/type";
import type { ListState } from "./Main";

/** Human words for the backend's error codes the list can show. */
function describe(code: string): string {
  if (code === "no_accounts") return "Add an account in Omamail to read mail here.";
  if (code === "auth_required") return "This account needs to sign in again.";
  return `The mailbox could not be loaded (${code}).`;
}

/** The middle pane: the mailbox's name, then one row per message, newest first. */
export function MessageList(props: {
  title: string;
  state: ListState;
  selected: string | null;
  query: string;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  onSearch: (query: string) => void;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  const count = () => (props.state.kind === "page" ? props.state.page.messages.filter((m) => m.unread).length : 0);
  return (
    <View class="w-[360px] border-r border-border">
      <View class="h-[44px] flex-row items-center gap-2 border-b border-border px-4">
        <Title class="flex-1">{props.title}</Title>
        <If when={count() > 0}>
          <Caption>{`${count()} unread`}</Caption>
        </If>
      </View>
      <View class="border-b border-border px-3 py-2">
        <Input
          accessibilityLabel="Search mail"
          placeholder="Search mail"
          size="small"
          value={props.query}
          onSubmit={({ value }) => props.onSearch(value.trim())}
        />
      </View>
      <If when={props.state.kind === "loading"}>
        <EmptyState class="flex-1 border-0" title="Loading" icon="loader-circle" />
      </If>
      <If when={props.state.kind === "error"}>
        <EmptyState
          class="flex-1 border-0"
          title="Nothing to show"
          icon="circle-alert"
          description={props.state.kind === "error" ? describe(props.state.code) : ""}
        >
          <Button label="Try again" onPress={props.onRetry} />
        </EmptyState>
      </If>
      <If when={props.state.kind === "page" && props.state.page.messages.length === 0}>
        <EmptyState
          class="flex-1 border-0"
          title={props.query ? "No matches" : "No messages"}
          icon={props.query ? "search" : "inbox"}
          description={props.query ? `Nothing in ${props.title} matches “${props.query}”.` : ""}
        >
          <If when={props.query !== ""}>
            <Button label="Clear search" onPress={() => props.onSearch("")} />
          </If>
        </EmptyState>
      </If>
      <If when={props.state.kind === "page" && props.state.page.messages.length > 0}>
        <List
          class="flex-1"
          testID="messages"
          estimatedItemSize={72}
          each={props.state.kind === "page" ? props.state.page.messages : []}
          keyExtractor={(m) => m.id}
        >
          {(m) => (
            <View class="border-b border-border">
              <ListItem
                class="h-[71px] items-start px-4 py-2.5"
                accessibilityLabel={`${m().from}: ${m().subject}`}
                selected={props.selected === m().id}
                onPress={() => props.onSelect(m().id)}
              >
                <View class="flex-1 gap-1">
                  <View class="h-[16px] flex-row items-center gap-2">
                    <Body class={`flex-1 truncate ${m().unread ? "font-semibold text-bright" : ""}`}>{m().from}</Body>
                    <If when={m().starred}>
                      <Icon name="star" size={12} class="text-warning" />
                    </If>
                    <If when={m().unread}>
                      <View class="size-1.5 bg-omarchy-accent" />
                    </If>
                    <Caption>{m().time}</Caption>
                  </View>
                  <Body class={`truncate ${m().unread ? "text-bright" : ""}`}>{m().subject || "(no subject)"}</Body>
                  <Caption class="truncate">{m().snippet}</Caption>
                </View>
              </ListItem>
            </View>
          )}
        </List>
        <If when={props.hasMore}>
          <View class="border-t border-border px-3 py-2">
            <Button label="Load more" variant="ghost" loading={props.loadingMore} onPress={props.onMore} />
          </View>
        </If>
      </If>
    </View>
  );
}
