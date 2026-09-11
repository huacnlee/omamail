# AI beside your mail

Omamail reads the default AI selected in Omarchy. There is no Omamail AI settings
page or separate Agent page. The background adapter currently supports Claude;
other defaults produce an inline explanation without opening a terminal or picker.
The installed Claude CLI uses its normal system login and provider configuration.

Choose the outline **AI icon** button beside Compose in the window header, the
message menu, or `Alt+G` in the list, reader or composer. The right dock displays
the conversation, aligned to the bottom with older turns above. Drag its left
edge to resize; double-click the divider to restore the default width. User messages
have a background and a › marker; AI replies have no background and each offers
a copy icon after generation finishes that copies the original reply. Bold and code are formatted
through an escaping formatter that cannot create links or remote resources. Execution status appears just above the input, which starts at one line and
grows with newlines.
Type `/` to show commands, then use Up/Down and Return or click a suggestion.
Selecting a command only fills editable instructions. **Enter** sends;
**Shift+Enter** inserts a newline. Ctrl+Enter also sends. While running, the
stop icon ends the request. The **…** menu contains **New chat** and **History...**
for the current mail or draft. The header AI button closes the dock without stopping an active request.
While running, a timed Working line stays above the input and Escape interrupts
the request; when idle, Escape closes the dock.

While AI is working, Enter adds another message to a Pending queue and clears
the input immediately. Messages run in order in the same conversation after
each successful reply. Click a pending message to bring it back into an empty
input for editing, or remove it with ×. A failed start retains the message;
interrupting or a failed reply pauses the queue. Pending messages are held only
for this application session, with up to 20 messages and bounded text size.
They never switch to another mail or conversation. The queue for a request still
preparing its first turn waits until that conversation can be identified.

The worker runs silently in the background. Text appears progressively, along
with public status events such as reading a file or finishing a tool. Raw tool
arguments/results, diagnostics, and internal reasoning are not displayed.
Completed requests can be followed up in the same native Claude conversation.
The **New chat** action reads the current mail or draft into a fresh conversation.
Follow-ups keep the original context; a notice identifies a draft edited since
that context was captured.

A request can cover at most 20 messages from one mailbox. The owning provider's
normal read interface supplies complete bodies without selecting or marking mail
read. Results stay bound to their account, messages and draft identity. You can
select history text or copy each answer. Translation and rewriting commands act
only on mail titles and bodies, excluding addresses and metadata. Their results
separate Title and Body; draft insertion takes only the Body section, so a
translated title is not accidentally inserted into the body. In a draft, **Insert at cursor**
and **Replace body** apply only a completed successful reply; neither sends mail.
Replacement is two text edits and can require two undo steps. The mail list has no AI icon. The header AI button stays static without a
breathing animation.

## Background bridge

`AgentContext.qml` requests account-bound context from Rust; `AgentRunner.qml`
polls native task projections and validated display snapshots.
The persistent Rust backend accepts structured job requests over JSON-RPC and launches a detached `omamail agent-worker` process. The worker launches the installed Claude
CLI with non-interactive streaming JSON output. Mail and questions reach Claude
through stdin, never process arguments. No terminal launcher is invoked.
Already-running workers from the prior Python bridge remain visible and cancellable
during an upgrade; new tasks always use the native worker.

Each turn has a private 0700 directory under
`$XDG_STATE_HOME/omamail/assistant/<turn-id>/`; files are 0600. The parser imports
only bounded, validated UTF-8 public text/status events. It rejects malformed or
incomplete streams and never treats a partial response as a successful draft
suggestion. Per-turn answers are limited to 64 KiB; conversation snapshots have
bounded entries and bytes. Oversized history requires a new chat instead of
silently dropping context. At most four requests run and 32 turns are retained.
Retention deletes only validated directory basenames.

A follow-up accepts only the parent turn ID and the new question. Account,
message and draft identity cannot be overridden. A successful native session is
resumed with a fork, so branching from retained turns does not mix histories.
Continuation stays on the parent's provider even if the system default changes.
Old terminal-based jobs cannot be continued; start a new chat for them.

Claude runs with non-interactive `dontAsk` permissions: no hidden approval prompt
can leave the panel waiting for input in another window. Permission or login
failures appear in the panel. Omamail does not copy the interactive launcher's
auto-approval flags. Existing system configuration and tool permissions still
apply; this bridge is not a sandbox. Treating mail as untrusted context is an AI
instruction, not a technical restriction on its tools. Supplied content goes to
the provider configured for the system AI.

Cancellation and the request deadline stop the worker's child process group.
Tools that detached or submitted work to an existing daemon may continue. Raw
stderr is discarded rather than displayed or persisted, to avoid leaking tool
or login diagnostics. Omamail never automatically sends a message or applies AI
text.

## Verification

Backend tests use synthetic Claude streams and inspect actual process arguments,
stdin and child lifetime. They cover progressive output, native continuation,
absence of terminal launch, failure/limits, safe retention and ownership. QML
tests cover Enter/Shift+Enter submission, history selection while streaming, scroll,
errors, draft insertion and account/context ownership. Native previews verify
the current Omarchy theme and compact dock layout.

A real installed-Claude smoke check also passed two synthetic turns: the second
turn recalled a word supplied in the first. No real mailbox content was used.
