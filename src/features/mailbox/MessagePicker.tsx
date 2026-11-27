// Where messages go when they leave with somewhere to be (LabelPicker.qml).
// The field owns the focus from the moment it opens and the keyboard walks
// the list under it: a destination is picked by typing three letters and
// pressing Return, never by arrowing through thirty. A click moves the
// cursor; Return or a double click takes it, so a pointer user can see the
// destination before mail moves there.
//
// Two pickers share it: `MovePicker` (the `v` key: labels, and on a folder
// provider the Inbox too) and `LabelPicker` (labels to add). Open them with
// `openMovePicker(ids, onChoose)` / `openLabelPicker(ids, onChoose)`; the
// caller runs the action (`label:<id>` in the Qt list) on the ids it gave.
import { batch, effect, signal, untracked, Text } from "nsh";
import { app } from "../../app/store";
import { labelIdOfMailbox, movableLabels } from "../../mail/labels";
import { capabilities, labelsAreFolders } from "../../mail/mailboxes";
import { cx, Dialog, FinderPanel, Input, PickerRow, ScrollBox, TEXT } from "../../ui";
import { PickerKeys } from "./LabelMenu";
import { labelPick, movePick, type MessagePickRequest } from "./popups";
import { mailboxStore } from "./store";

/** Why a picker cannot open here, or "" (App.qml openLabelPicker). */
export function pickerRefusal(ids: readonly string[]): string {
  if (ids.length === 0) return "Choose a message first";
  if (app.unified()) return "Moving to a label needs one mailbox on screen";
  const account = app.account();
  if (!account) return "Moving to a label needs one mailbox on screen";
  const caps = capabilities(account.provider);
  if (!caps.labels && !caps.move) return "This mailbox has no folders or labels to move into";
  return "";
}

function open(target: typeof movePick, ids: string[], onChoose: MessagePickRequest["onChoose"]): boolean {
  const refusal = pickerRefusal(ids);
  if (refusal !== "") {
    app.setNotice(refusal);
    return false;
  }
  batch(() => {
    movePick.set(null);
    labelPick.set(null);
    target.set({ ids: ids.slice(), currentLabelId: labelIdOfMailbox(app.mailbox()), onChoose });
  });
  return true;
}

/** Opens "Move to" for these messages; false (with the reason noted) when it cannot here. */
export function openMovePicker(ids: string[], onChoose: MessagePickRequest["onChoose"]): boolean {
  return open(movePick, ids, onChoose);
}

/** Opens "Label as" for these messages; false (with the reason noted) when it cannot here. */
export function openLabelPicker(ids: string[], onChoose: MessagePickRequest["onChoose"]): boolean {
  return open(labelPick, ids, onChoose);
}

export interface MessagePickerProps {
  /** Overrides the store's request: controlled use. */
  request?: MessagePickRequest | null;
  onClose?: () => void;
}

/** "Move to": labels, and on a folder provider the Inbox (a destination with no key of its own). */
export function MovePicker(props: MessagePickerProps) {
  return (
    <PickerDialog
      title="Move to"
      testID="move-picker"
      folders
      request={props.request !== undefined ? props.request : movePick()}
      onClose={() => (props.onClose ? props.onClose() : movePick.set(null))}
    />
  );
}

/** "Label as": a Gmail-style label added to the messages. */
export function LabelPicker(props: MessagePickerProps) {
  return (
    <PickerDialog
      title="Label as"
      testID="label-picker"
      folders={false}
      request={props.request !== undefined ? props.request : labelPick()}
      onClose={() => (props.onClose ? props.onClose() : labelPick.set(null))}
    />
  );
}

function PickerDialog(props: {
  title: string;
  testID: string;
  folders: boolean;
  request: MessagePickRequest | null;
  onClose: () => void;
}) {
  const query = signal("");
  const cursor = signal(0);
  effect(() => {
    props.request;
    untracked(() => {
      query.set("");
      cursor.set(0);
    });
  });
  const folders = () => props.folders && !!app.account() && labelsAreFolders(app.account()!.provider);
  const matches = () => movableLabels(mailboxStore.labels(), query(), props.request?.currentLabelId ?? "", folders());
  const total = () => movableLabels(mailboxStore.labels(), "", props.request?.currentLabelId ?? "", folders()).length;
  const choose = (index: number) => {
    const request = props.request;
    const label = matches()[index];
    if (!request || !label) return;
    props.onClose();
    request.onChoose(String(label.id), request.ids);
  };
  return (
    <Dialog
      testID={props.testID}
      variant="finder"
      title={props.title}
      width={360}
      open={props.request !== null}
      closeOnEscape
      onOpenChange={(e) => {
        if (!e.open) props.onClose();
      }}
    >
      <PickerKeys active={() => props.request !== null} onEscape={props.onClose} class="gap-5" count={() => matches().length} cursor={cursor} onChoose={() => choose(cursor())}>
        <FinderPanel title="Filter" bodyClass="p-2">
          <Input
            variant="plain"
            testID={`${props.testID}-field`}
            value={query()}
            placeholder="Type a folder or label"
            autoFocus
            accessibilityLabel="Filter folders or labels"
            onChange={(e) =>
              batch(() => {
                query.set(e.value);
                cursor.set(0);
              })
            }
            onSubmit={() => choose(cursor())}
          />
        </FinderPanel>
        <FinderPanel
          testID={`${props.testID}-results`}
          title={folders() ? "Folders and labels" : "Labels"}
          count={`${matches().length} / ${total()}`}
         
          bodyClass="p-1"
        >
          <ScrollBox maxHeight={280} class="gap-0.5">
            <Each of={matches()} key="index">
              {(label, index) => (
                <PickerRow
                  testID={`${props.testID}-row-${index()}`}
                  label={String(label().leaf || label().name || "")}
                  icon={label().id.toLowerCase() === "inbox" ? "inbox" : folders() ? "folder" : "label"}
                  depth={label().depth}
                  cursor={cursor() === index()}
                  onPress={(clicks) => {
                    cursor.set(index());
                    if (clicks === 0 || clicks >= 2) choose(index());
                  }}
                />
              )}
            </Each>
          </ScrollBox>
          <If when={matches().length === 0}>
            <Text class={cx("px-2 py-1.5", TEXT.caption)}>
              {query() === "" ? "No folders or labels to move into" : "No folder or label matches that"}
            </Text>
          </If>
        </FinderPanel>
      </PickerKeys>
    </Dialog>
  );
}
