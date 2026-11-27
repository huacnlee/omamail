// The popups the label rows and the pickers open, as state the sidebar
// renders. Every label popup is opened for one account and answers to it by
// id whatever the window has switched to since; a switch closes them, since a
// prompt about a mailbox no longer on screen is a trap (App.qml
// closeLabelPopups).
import { batch, signal } from "nsh";
import type { MoveTarget } from "../../mail/labels";

export interface NamePromptRequest {
  kind: "rename" | "create";
  /** The label id to rename, or the parent path to create under. */
  subject: string;
  title: string;
  initial: string;
  hint: string;
  accountId: string;
}

export interface LabelMoveRequest {
  accountId: string;
  labelId: string;
  path: string;
  targets: MoveTarget[];
}

/** A message picker's question: which messages, and who acts on the answer. */
export interface MessagePickRequest {
  ids: string[];
  /** The label or folder the list is in, which cannot be its own destination. */
  currentLabelId: string;
  onChoose: (labelId: string, ids: string[]) => void;
}

export const namePrompt = signal<NamePromptRequest | null>(null);
export const labelMove = signal<LabelMoveRequest | null>(null);
/** The open label menu's row, by path, so it stays selected while the menu is open. */
export const menuPath = signal<string>("");
export const movePick = signal<MessagePickRequest | null>(null);
export const labelPick = signal<MessagePickRequest | null>(null);
/** The account switcher is open. */
export const switcherOpen = signal<boolean>(false);

export function closeLabelPopups() {
  batch(() => {
    namePrompt.set(null);
    labelMove.set(null);
    menuPath.set("");
  });
}

/** Closes whichever of this feature's popups is open; false when none was. */
export function closeMailboxPopups(): boolean {
  const open = namePrompt() !== null || labelMove() !== null || movePick() !== null || labelPick() !== null || switcherOpen();
  if (!open) return false;
  batch(() => {
    closeLabelPopups();
    movePick.set(null);
    labelPick.set(null);
    switcherOpen.set(false);
  });
  return true;
}
