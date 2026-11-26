import { View } from "nsh";
import { Button, Dialog, Input, Textarea } from "nsh-omarchy";
import { Caption } from "./ui/type";

/** A message being written: new, a reply or a forward. */
export type DraftState = { to: string; cc: string; subject: string; body: string };

/** The compose dialog: recipients, subject and a plain-text body. */
export function Compose(props: {
  open: boolean;
  draft: DraftState;
  from: string;
  sending: boolean;
  error: string;
  onChange: (draft: DraftState) => void;
  onSend: () => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<DraftState>) => props.onChange({ ...props.draft, ...patch });
  return (
    <Dialog
      title={props.draft.subject || "New message"}
      description={props.from ? `From ${props.from}` : undefined}
      open={props.open}
      onOpenChange={({ open }) => !open && props.onClose()}
      footer={
        <View class="flex-row items-center justify-end gap-2">
          <If when={props.error !== ""}>
            <Caption class="flex-1 text-danger">{props.error}</Caption>
          </If>
          <Button label="Discard" variant="ghost" onPress={props.onClose} />
          <Button
            label="Send"
            variant="primary"
            loading={props.sending}
            disabled={props.sending || props.draft.to.trim() === ""}
            onPress={props.onSend}
          />
        </View>
      }
    >
      <View class="gap-3">
        <Input
          accessibilityLabel="To"
          placeholder="To"
          value={props.draft.to}
          autoFocus={props.draft.to === ""}
          onChange={({ value }) => set({ to: value })}
        />
        <Input accessibilityLabel="Cc" placeholder="Cc" value={props.draft.cc} onChange={({ value }) => set({ cc: value })} />
        <Input
          accessibilityLabel="Subject"
          placeholder="Subject"
          value={props.draft.subject}
          onChange={({ value }) => set({ subject: value })}
        />
        <Textarea
          accessibilityLabel="Message"
          placeholder="Write your message"
          rows={14}
          value={props.draft.body}
          onChange={({ value }) => set({ body: value })}
        />
      </View>
    </Dialog>
  );
}
