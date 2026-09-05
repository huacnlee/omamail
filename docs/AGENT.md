# The message agent

How a message is handed to an agent, where that agent runs, how the window knows what it is doing, and how it is stopped. Written before the code, and kept true by it.

## What it is

Settings names a **default agent**: a command line that reads a prompt on stdin and writes its answer on stdout — `claude -p`, `grok`, `codex exec`, a script. Nothing here knows which one it is. With no command set there is no agent button anywhere, by the same rule that hides Archive on a server with no archive: a button that cannot act is worse than none.

A message gains an agent button, in the reader's action bar and in the row's hover lane. It opens a popup — a `QQC.Popup` in the window, not a second window — with one field: what to ask about this message. Submitting starts a job and closes the popup. Closing the popup without submitting starts nothing. Once a job exists for a message, the same button reopens the popup on that job: what it is doing, what it said, and a **Cancel actions** control. Closing that popup does not cancel. Only Cancel actions does.

## Where the job runs

Not inside the shell. The window is a plugin in the process that draws the whole desktop, and a long-running child of it dies with `omarchy restart shell`, blocks nothing but is killed by everything. So a job is a transient **systemd user unit**: `systemd-run --user --unit omamail-agent-<id> --collect scripts/agent-job.sh <jobdir>`. It survives the shell, the window and the session's other restarts; its output is in the journal; and stopping it is `systemctl --user stop omamail-agent-<id>`, which is the whole of Cancel actions. This is what Omarchy uses for its own background work, so it is the native answer rather than a daemon of this plugin's own.

The job directory is `$XDG_STATE_HOME/omamail/agent/<id>/`, mode 0700, and holds:

- `job.json` — what was asked: the message id, the account address, the folder, the prompt, the agent command, and the timestamps. The runner rewrites it as the job moves: `state` is `queued`, `running`, `done`, `failed` or `cancelled`; `summary` is the last non-empty line the agent wrote; `question` is set when the agent's last line begins `QUESTION:`.
- `message.txt` — the message as the window had it: the headers a reader would want, then the text body. Written by the window, never by the agent.
- `prompt.txt` — what the agent is handed on stdin: the rules, the message, the ask.
- `output.log` — everything the agent wrote.

Everything a stranger wrote goes into files. Nothing from a message, a prompt or a job reaches a command line. The agent command itself is the user's own and runs through `sh -c`; it is not sender-controlled.

## Mail I/O

The agent reads and writes mail through **himalaya**, not through this plugin. The prompt tells it which account it is standing in by address (`himalaya account list` names them), which folder, and the rule set from the mailbox skill: list before reading, read one message, never dump a mailbox, never send unless the ask says to send, never print a credential or a token. The plugin gives it the message it was asked about so the first read costs nothing; every further read, search, move or send is himalaya's.

## How the window knows

`agent/AgentRunner.qml` owns the jobs the window can see. It reads every `job.json` under the state directory on open and again every few seconds while any job is not finished — a poll rather than a watch, because a directory of small files rewritten by another process is exactly the case a file watcher reports late or twice, and a two-second poll while something is running costs nothing measurable. `agent/Agent.js` holds every decision: what a job file means, which job a message has, what the row and the popup say for each state, and how a job id and a unit name are derived. That is where the tests are.

A row whose message has a job shows the agent glyph in its action lane with the state — running, a question waiting, done, failed — and the reader's button holds a selected style while the popup is up. A job finishing writes one status-line note, the same way an action does.

## The pane

Beside a message's own button there is a pane — the third root of the window after mail and the calendar, reached from the rail's foot or `Ctrl+Shift+G`. It takes an ask about the open mailbox or every mailbox: find the messages about X between two dates, find the last message from someone about something and draft a reply from what another thread says. No message crosses; the job carries a **scope** (`account:<address>` or `all`) and every address the agent may look in, and the agent does its own listing, searching and reading through himalaya. The pane lists these jobs newest first, and the open one shows the tail of what the agent wrote, re-read every two seconds while it runs (`agent-job.py show`). Cancel actions is the same `systemctl --user stop`.

## Not in the first slice

- Answering a question. The state, the glyph and the pane's card are there; the reply path — writing the answer into the job and resuming the agent — is the next slice, and depends on the agent command having a resume flag to give it.
- A job over a selection. The popup and the runner take one message. A selection is a list of message files in one job directory and one prompt naming them, and nothing above the runner changes.
- A per-account himalaya account name. The pane hands over every address and the agent matches them against `himalaya account list`. The address is enough for himalaya to be told which it is.
