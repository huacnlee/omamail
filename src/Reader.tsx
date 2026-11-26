import { Scroll, View } from "nsh";
import { EmptyState, Icon, IconButton, Separator } from "nsh-omarchy";
import { Body, Caption, Heading } from "./ui/type";
import type { Body as MessageBody, Message } from "omamail-native";
import type { Action } from "./Main";

/** What the reader shows under the header: loading, an error code, or the text. */
export type BodyState = { kind: "loading" } | { kind: "error"; code: string } | { kind: "body"; body: MessageBody };

/** The right pane: the selected message's header and plain-text body. */
export function Reader(props: {
  message: Message | undefined;
  body: BodyState;
  mailbox: string;
  onAction: (action: Action) => void;
  onReply: () => void;
  onForward: () => void;
}) {
  const open = () => props.message !== undefined;
  return (
    <View class="flex-1">
      <View class="h-[44px] flex-row items-center gap-1 border-b border-border px-3">
        <If when={open()}>
          <IconButton icon="arrow-left" label="Reply" onPress={props.onReply} />
          <IconButton icon="arrow-right" label="Forward" onPress={props.onForward} />
          <View class="mx-1 h-4 w-px bg-border" />
          <If when={props.mailbox !== "archive"}>
            <IconButton icon="folder" label="Archive" onPress={() => props.onAction("archive")} />
          </If>
          <If when={props.mailbox !== "trash"}>
            <IconButton icon="trash" label="Delete" onPress={() => props.onAction("trash")} />
          </If>
          <If when={props.mailbox !== "spam"}>
            <IconButton icon="triangle-alert" label="Report spam" onPress={() => props.onAction("spam")} />
          </If>
          <View class="flex-1" />
          <IconButton
            icon={"star"}
            label={props.message?.starred ? "Unstar" : "Star"}
            onPress={() => props.onAction(props.message?.starred ? "unstar" : "star")}
          />
          <IconButton
            icon={props.message?.unread ? "check" : "eye"}
            label={props.message?.unread ? "Mark as read" : "Mark as unread"}
            onPress={() => props.onAction(props.message?.unread ? "read" : "unread")}
          />
        </If>
      </View>
      <If when={props.message} else={<EmptyState class="flex-1 border-0" title="No message selected" icon="inbox" />}>
        <Scroll class="flex-1" testID="reader">
          <View selectable class="gap-4 px-8 py-6">
            <Heading>{props.message?.subject || "(no subject)"}</Heading>
            <View class="flex-row items-center gap-3">
              <View class="size-8 items-center justify-center bg-surface">
                <Icon name="user" size={16} class="text-text-secondary" />
              </View>
              <View class="flex-1 gap-0.5">
                <Body class="font-semibold text-bright">{props.message?.from ?? ""}</Body>
                <Caption>{props.message?.fromEmail ?? ""}</Caption>
              </View>
              <Caption>{props.message?.fullTime ?? ""}</Caption>
            </View>
            <Separator />
            <If when={props.body.kind === "loading"}>
              <Caption>Loading message…</Caption>
            </If>
            <If when={props.body.kind === "error"}>
              <Caption>{props.body.kind === "error" ? `The message could not be loaded (${props.body.code}).` : ""}</Caption>
            </If>
            <If when={props.body.kind === "body"}>
              <Body class="leading-[20px]">
                {props.body.kind === "body" ? props.body.body.text || props.message?.snippet || "" : ""}
              </Body>
              <If when={props.body.kind === "body" && props.body.body.attachments.length > 0}>
                <View class="gap-1.5 border-t border-border pt-3">
                  <Each of={props.body.kind === "body" ? props.body.body.attachments : []}>
                    {(name) => (
                      <View class="flex-row items-center gap-2">
                        <Icon name="file" size={12} class="text-text-secondary" />
                        <Caption>{name()}</Caption>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
            </If>
          </View>
        </Scroll>
      </If>
    </View>
  );
}
