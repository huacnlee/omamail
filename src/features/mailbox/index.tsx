// Feature entry: the shell and the other features import only what this file
// exports. Owner: the mailbox agent.
//
//   <MailboxSidebar />   the rail (renders the label popups and pickers too)
//   <MailboxTabs />      compact mode's row of mailbox tabs
//   openMovePicker(ids, onChoose) / openLabelPicker(ids, onChoose)
//                        "Move to" (v) / "Label as" for those messages; the
//                        caller runs `label:<id>` on the ids it gave
//   messageDrag          drag messages onto the sidebar (see drag.ts)
//   mailboxStore         labels, slots (goSlot, setSlotHintsVisible), counts
//   labelMailboxKey / labelIdOfMailbox
//                        a label's list is app.openMailbox("label:<id>")
export { MailboxSidebar } from "./Sidebar";
export { MailboxTabs } from "./MailboxTabs";
export { LabelPicker, MovePicker, openLabelPicker, openMovePicker, pickerRefusal } from "./MessagePicker";
export { AccountSwitcher, UNIFIED_LABEL } from "./AccountSwitcher";
export { messageDrag, dropView, type DropTarget } from "./drag";
export { mailboxStore, SLOT_LIMIT } from "./store";
export { labelMailboxKey, labelIdOfMailbox } from "../../mail/labels";
