// A draft the AI proposed: its subject and body for the owner to review,
// under the routing the app chose. The model never sets who receives it or
// whether it is sent; the owner edits recipients here or in the editor, and
// only the owner's press on "Send email" queues it in the outbox.
import { Text, View, createMotion, reduceMotion, signal } from "nsh";
import { attachmentLabels, proposalDraft, proposalEnvelope, replyOnly, type Proposal, type ProposalEnvelope } from "../../mail/agent";
import { Button, Checkbox, Input, TEXT, Titled, cx, enterRise, DISTANCE, sizedBox } from "../../ui";
import { host } from "./host";
import { sendProposal } from "./service";
import { assistant } from "./store";

export const ROUTING_CHANGED = "The sender, recipients or quoted history changed. Edit the draft to send with your current choices.";

const DELIVERY: Record<string, string> = {
  queued: "Queued for sending", sending: "Sending...", sent: "Sent", failed: "Send failed",
  cancelled: "Send undone", unknown: "Check Sent — delivery unknown",
};

/** The envelope the owner would send: the proposal's text, the app's routing, the owner's edits. */
export function outgoingEnvelope(proposal: Proposal, edits: { to?: string; cc?: string; includeHistory?: boolean }): ProposalEnvelope | null {
  const source = proposal.envelope;
  if (!source) return null;
  const envelope = proposalEnvelope({ ...source, subject: String(proposal.subject), body: String(proposal.body) });
  if (edits.to !== undefined) envelope.to = edits.to;
  if (edits.cc !== undefined) envelope.cc = edits.cc;
  if (edits.includeHistory === false) envelope.body = replyOnly(envelope.body, envelope.replyQuote);
  return envelope;
}

let draftSerial = 0;

// Per-proposal view state, by id: list cells are reused for other rows, so
// a cell keeps none of its own.
const editingIds = signal<Record<string, boolean>>({});
const sendingIds = signal<Record<string, boolean>>({});
function flag(map: typeof editingIds, id: string, on: boolean) {
  map.update((all) => ({ ...all, [id]: on }));
}

export function ProposalCard(props: { proposal: Proposal; jobId: string }) {
  const editing = () => !!editingIds()[props.proposal.id];
  const motion = createMotion({ initial: reduceMotion() ? {} : { opacity: 0, translateY: DISTANCE.toast } });
  if (!reduceMotion()) motion.play(enterRise(DISTANCE.toast));
  const envelope = () => props.proposal.envelope || null;
  const edits = () => assistant.proposalEdits()[props.proposal.id] || {};
  const toValue = () => (edits().to !== undefined ? edits().to! : String(envelope()?.to || ""));
  const ccValue = () => (edits().cc !== undefined ? edits().cc! : String(envelope()?.cc || ""));
  const sendId = () => "agent-" + props.proposal.id;
  const delivery = () => {
    const e = envelope();
    return e ? host().composer.deliveryState(String(e.accountId), sendId()) : "";
  };
  const submitted = () => delivery() !== "" || !!assistant.sentProposals()[props.proposal.id];
  const previousSubmission = () => submitted() && !assistant.sentProposals()[props.proposal.id];
  const routingChanged = () => {
    const e = envelope();
    return !!e && host().composer.routingChanged(e, props.proposal.id);
  };
  const included = () => !!envelope()?.replyQuote && edits().includeHistory !== false;
  const sending = () => !!sendingIds()[props.proposal.id];

  const recipients = () => {
    const e = envelope();
    if (previousSubmission()) return "Original proposal. The recipients and history used for delivery are not available in this preview.";
    if (!e) return "This proposal has no saved recipients or attachment snapshot. Ask again from its message or draft.";
    return ["From: " + String(e.from || ""), "To: " + toValue(), ccValue() ? "Cc: " + ccValue() : "",
      e.bcc ? "Bcc: " + e.bcc : "", e.replyTo ? "Reply-To: " + e.replyTo : ""].filter(Boolean).join("\n");
  };

  const editDraft = () => {
    const outgoing = outgoingEnvelope(props.proposal, edits());
    if (!outgoing || !props.proposal.applicable) return;
    const target = assistant.target();
    if (target && target.kind === "draft") {
      if (!host().composer.applyProposal(outgoing, props.proposal.id, props.jobId))
        assistant.setLocalError("Open this proposal's draft to apply it.");
      return;
    }
    host().composer.beginProposal(proposalDraft(outgoing, props.jobId, "agent-" + Date.now().toString(36) + "-" + ++draftSerial));
  };

  const send = async () => {
    const outgoing = outgoingEnvelope(props.proposal, edits());
    if (!outgoing || !props.proposal.applicable || submitted() || sending()) return;
    if (routingChanged()) {
      assistant.setLocalError(ROUTING_CHANGED);
      return;
    }
    const id = props.proposal.id;
    flag(sendingIds, id, true);
    const ok = await sendProposal(id, outgoing, props.jobId);
    flag(sendingIds, id, false);
    if (ok) assistant.markSent(id);
    else assistant.setLocalError("Could not queue this email. Check its recipients and mailbox.");
  };

  return (
    <View testID="agent-draft-proposal" style={motion.style} accessibilityLabel="Proposed draft" class="pt-2">
    <Titled title="Proposed reply" surface="muted" bodyClass="gap-3 p-4">
      <View class="flex-row items-start gap-2">
        <Text testID="agent-proposal-recipients" class={cx(TEXT.caption, "flex-1")}>{recipients()}</Text>
        <If when={!!envelope() && !submitted()}>
          <Button
            testID="agent-edit-recipients"
            size="small"
            variant="ghost"
            label={editing() ? "Done editing recipients" : "Edit recipients"}
            onPress={() => flag(editingIds, props.proposal.id, !editing())}
          />
        </If>
      </View>
      <If when={editing() && !submitted()}>
        <View class="gap-1.5">
          <View class="flex-row items-center gap-2">
            <Text class={cx(TEXT.caption, sizedBox("w-6", "w", 24))}>To</Text>
            <View class="flex-1">
              <Input size="small" accessibilityLabel="To" placeholder="recipient@example.com" value={toValue()}
                onChange={(e) => assistant.editProposal(props.proposal.id, "to", e.value)} />
            </View>
          </View>
          <View class="flex-row items-center gap-2">
            <Text class={cx(TEXT.caption, sizedBox("w-6", "w", 24))}>Cc</Text>
            <View class="flex-1">
              <Input size="small" accessibilityLabel="Cc" placeholder="recipient@example.com" value={ccValue()}
                onChange={(e) => assistant.editProposal(props.proposal.id, "cc", e.value)} />
            </View>
          </View>
        </View>
      </If>
      <Text testID="agent-proposal-subject" class={cx(TEXT.listTitle, "font-semibold text-bright")}>{"Subject: " + props.proposal.subject}</Text>
      <View selectable>
        <Text class={TEXT.message}>{replyOnly(props.proposal.body, envelope()?.replyQuote || "")}</Text>
      </View>
      <If when={(envelope()?.attachments || []).length > 0}>
        <Text class={TEXT.caption}>{"Attachments: " + attachmentLabels(envelope()?.attachments)}</Text>
      </If>
      <If when={!previousSubmission() && !!envelope()?.replyMessageId}>
        <If
          when={!!envelope()?.replyQuote}
          else={<Text testID="agent-proposal-no-quote" class={TEXT.caption}>The original message has no quoted history to include.</Text>}
        >
          <Checkbox
            testID="agent-proposal-history"
            label="Include quoted history"
            checked={included()}
            disabled={submitted()}
            onChange={(e) => assistant.editProposal(props.proposal.id, "includeHistory", e.checked)}
          />
        </If>
      </If>
      <View class="flex-row flex-wrap justify-end gap-2">
        <Button
          label="Edit draft..."
          disabled={!envelope() || !props.proposal.applicable || previousSubmission() || (submitted() && !["failed", "cancelled", "unknown"].includes(delivery()))}
          onPress={editDraft}
        />
        <Button
          testID="agent-send-email"
          variant="primary"
          icon={delivery() === "sent" ? "check" : null}
          loading={sending() || delivery() === "sending"}
          label={DELIVERY[delivery()] || (submitted() ? "Checking send status..." : "Send email")}
          disabled={!envelope() || !props.proposal.applicable || submitted() || routingChanged()}
          onPress={send}
        />
      </View>
      <If when={routingChanged() && !submitted()}>
        <Text testID="agent-proposal-routing-changed" class={cx(TEXT.caption, TEXT.warning)}>{ROUTING_CHANGED}</Text>
      </If>
    </Titled>
    </View>
  );
}
