// What a label row's menu offers about the label itself (not the messages in
// it), its name prompt and its move picker. Port of LabelMenu.qml,
// NamePrompt.qml, LabelMovePicker.qml and App.qml's label wiring. Rows that
// change the server's list are offered only where the provider can be asked;
// an ancestor no label names offers only the two rows that make a label.
import { effect, signal, untracked, View, type JSX, type Signal } from "nsh";
import { labelDelimiter, labelLeaf, labelMoveTargets, labelParent, wrappedIndex } from "../../mail/labels";
import {
  Button, confirmAction, Dialog, Input, MenuItem, MenuLabel, MenuSeparator, PickerRow, scaled, ScrollBox, FinderPanel,
} from "../../ui";
import { labelMove, namePrompt } from "./popups";
import { mailboxStore } from "./store";
import { pushKeyLayer, type KeyLayer } from "../../keys/commands";

export interface LabelMenuItemsProps {
  /** Whose label: the account open when the menu opened. */
  accountId: string;
  /** "" for an ancestor no label names. */
  labelId: string;
  path: string;
}

/** The rows of a label's menu, for a ContextMenu. */
export function LabelMenuItems(props: LabelMenuItemsProps) {
  const real = () => props.labelId !== "";
  const manage = () => mailboxStore.canManage(props.accountId);
  const watched = () => real() && mailboxStore.isMonitored(props.accountId, props.labelId);
  return (
    <>
      <MenuLabel label={props.path} />
      <If when={manage() && real()}>
        <MenuItem label="Rename..." icon="pencil" onSelect={() => askRename(props.accountId, props.labelId)} />
      </If>
      <If when={manage()}>
        <MenuItem label="New label beside..." icon="plus" onSelect={() => askCreate(props.accountId, props.path, false)} />
        <MenuItem label="New sub-label..." icon="plus" onSelect={() => askCreate(props.accountId, props.path, true)} />
      </If>
      <If when={manage() && real()}>
        <MenuItem label="Move to..." icon="folder" onSelect={() => askMove(props.accountId, props.labelId)} />
      </If>
      <If when={real()}>
        <MenuSeparator />
        <MenuItem
          label={watched() ? "Stop monitoring" : "Monitor for new mail"}
          icon="eye"
          checked={watched()}
          onSelect={() => mailboxStore.toggleMonitored(props.accountId, props.labelId)}
        />
      </If>
      <If when={manage() && real()}>
        <MenuItem label="Delete..." icon="trash" danger onSelect={() => void askDelete(props.accountId, props.labelId)} />
      </If>
    </>
  );
}

function askRename(accountId: string, labelId: string) {
  const label = mailboxStore.labelById(accountId, labelId);
  const path = mailboxStore.labelPathOf(label);
  namePrompt.set({
    kind: "rename",
    subject: labelId,
    title: `Rename ${path}`,
    initial: labelLeaf(path, labelDelimiter(label)),
    hint: "The new name for this label. Labels beneath it move with it.",
    accountId,
  });
}

function askCreate(accountId: string, path: string, beneath: boolean) {
  const labels = mailboxStore.labelsOf(accountId);
  const delimiter = labelDelimiter(labels[0] ?? null);
  const parent = beneath ? path : labelParent(path, delimiter);
  namePrompt.set({
    kind: "create",
    subject: parent,
    title: parent === "" ? "New label" : `New label under ${parent}`,
    initial: "",
    hint: "Its name at this level; nesting is the parent it goes under.",
    accountId,
  });
}

function askMove(accountId: string, labelId: string) {
  const label = mailboxStore.labelById(accountId, labelId);
  const path = mailboxStore.labelPathOf(label);
  labelMove.set({
    accountId,
    labelId,
    path,
    targets: labelMoveTargets(mailboxStore.labelsOf(accountId), path, labelDelimiter(label)),
  });
}

async function askDelete(accountId: string, labelId: string) {
  const path = mailboxStore.labelPathOf(mailboxStore.labelById(accountId, labelId));
  const yes = await confirmAction({
    title: `Delete "${path}"?`,
    description:
      "The label and every label beneath it are removed from the server. " +
      "On Gmail the messages keep their other labels; on IMAP the folder and its mail are deleted.",
    actionLabel: "Delete",
    destructive: true,
  });
  if (yes) mailboxStore.deleteLabel(accountId, labelId);
}

/** The name asked for a new or renamed label. */
export function NamePromptDialog() {
  const text = signal("");
  const request = () => namePrompt();
  effect(() => {
    const r = namePrompt();
    untracked(() => text.set(r ? r.initial : ""));
  });
  const submit = () => {
    const r = namePrompt();
    const value = text().trim();
    if (!r || value === "") return;
    namePrompt.set(null);
    if (r.kind === "rename") mailboxStore.renameLabel(r.accountId, r.subject, value);
    else mailboxStore.createLabel(r.accountId, r.subject, value);
  };
  return (
    <Dialog
      testID="label-name-prompt"
      title={request()?.title ?? ""}
      description={request()?.hint ?? null}
      open={request() !== null}
      closeOnEscape
      onOpenChange={(e) => {
        if (!e.open) namePrompt.set(null);
      }}
      footer={
        <View class="flex-row justify-end gap-2">
          <Button label="Cancel" variant="ghost" size="small" onPress={() => namePrompt.set(null)} />
          <Button
            label={request()?.kind === "rename" ? "Rename" : "Create"}
            variant="primary"
            size="small"
            disabled={text().trim() === ""}
            onPress={submit}
          />
        </View>
      }
    >
      <Input
        testID="label-name-field"
        value={text()}
        autoFocus
        accessibilityLabel="Label name"
        onChange={(e) => text.set(e.value)}
        onSubmit={submit}
      />
    </Dialog>
  );
}

/** Where a label goes: the top level, or under another label. */
export function LabelMoveDialog() {
  const cursor = signal(0);
  const request = () => labelMove();
  effect(() => {
    labelMove();
    untracked(() => cursor.set(0));
  });
  const targets = () => request()?.targets ?? [];
  const choose = (index: number) => {
    const r = labelMove();
    const target = r?.targets[index];
    if (!r || !target) return;
    labelMove.set(null);
    mailboxStore.moveLabel(r.accountId, r.labelId, target.path);
  };
  return (
    <Dialog
      testID="label-move-picker"
      variant="finder"
      title={`Move ${request()?.path ?? ""}`}
      width={360}
      open={request() !== null}
      closeOnEscape
      onOpenChange={(e) => {
        if (!e.open) labelMove.set(null);
      }}
    >
      <PickerKeys active={() => labelMove() !== null} onEscape={() => labelMove.set(null)} count={() => targets().length} cursor={cursor} onChoose={() => choose(cursor())} letters>
      <FinderPanel testID="label-move-results" title="Move under" count={String(targets().length)} bodyClass="p-1">
      <ScrollBox maxHeight={320} class="gap-0.5">
        <Each of={targets()} key="index">
          {(target, index) => (
            <PickerRow
              testID={`label-move-row-${index()}`}
              label={target().name}
              icon={target().path === "" ? "inbox" : "label"}
              cursor={cursor() === index()}
              onPress={(clicks) => {
                cursor.set(index());
                if (clicks !== 1) choose(index());
              }}
            />
          )}
        </Each>
      </ScrollBox>
      </FinderPanel>
      </PickerKeys>
    </Dialog>
  );
}

/**
 * The keys a picker answers while `active`, as a shell key layer
 * (`pushKeyLayer`, docs/NSH-PORT.md "Keys and commands"): Down / Up and
 * Ctrl+J / K / N / P walk a wrapping cursor; without a text field j / k walk
 * it too and Return or o takes it (with a field, its onSubmit takes it).
 */
export function PickerKeys(props: {
  active: () => boolean;
  count: () => number;
  cursor: Signal<number>;
  onChoose: () => void;
  /** Escape: close the picker (the layer takes the key before the field and the escape layers). */
  onEscape: () => void;
  /** No text field: the bare letters j, k and o answer too. */
  letters?: boolean;
  class?: string;
  /** Its width in points at base size; scaled with the Omarchy font. */
  width?: number;
  children?: JSX.Element;
}) {
  const step = (delta: number) => () => {
    const count = props.count();
    if (count > 0) props.cursor.set(wrappedIndex(props.cursor(), delta, count));
  };
  effect(() => {
    if (!props.active()) return;
    const keys: KeyLayer = {
      down: step(1), up: step(-1),
      "ctrl+j": step(1), "ctrl+k": step(-1), "ctrl+n": step(1), "ctrl+p": step(-1),
      escape: () => props.onEscape(),
    };
    if (props.letters) {
      keys.j = step(1);
      keys.k = step(-1);
      keys.o = () => props.onChoose();
      keys.enter = () => props.onChoose();
    }
    const remove = untracked(() => pushKeyLayer(keys));
    return remove;
  });
  return (
    <View class={props.class} style={props.width ? { width: scaled(props.width) } : undefined}>
      {props.children}
    </View>
  );
}
