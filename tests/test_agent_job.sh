#!/usr/bin/env bash
# The job runner, driven inline: a job directory is made from one JSON line, the
# agent is handed the prompt on stdin, and the job file follows it through
# running, done, failed and cancelled. Nothing here touches systemd or mail.
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d /tmp/omamail-agent-job-test.XXXXXX)
trap 'rm -rf "$work"' EXIT
export XDG_STATE_HOME="$work/state"
export OMAMAIL_AGENT_INLINE=1
runner="$project_dir/scripts/agent-job.py"
jobs="$XDG_STATE_HOME/omamail/agent"

fail() { echo "test_agent_job.sh: $1" >&2; exit 1; }

# Waits until the job named reaches one of the states given, or gives up.
wait_state() {
  local id=$1; shift
  for _ in $(seq 1 100); do
    state=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$jobs/$id/job.json")
    for wanted in "$@"; do [ "$state" = "$wanted" ] && return 0; done
    sleep 0.1
  done
  fail "job $id stayed in state $state"
}
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$jobs/$1/job.json" "$2"; }
new_job() { printf '%s\n' "$1" | python3 "$runner" new | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'; }

# A well-behaved agent: reads the prompt, answers, and its last line is the
# summary the window shows.
id=$(new_job '{"messageId":"41:INBOX","account":"ada@example.com","folder":"INBOX","subject":"Hello","command":"grep -c \"\" > count.txt; grep -q \"The ask:\" - <prompt.txt; echo \"I looked at it\"; echo \"Filed under Receipts\"","prompt":"File this","message":"From: Bob <bob@example.com>\nSubject: Hello\n\nA body line\n"}')
wait_state "$id" done failed cancelled
[ "$(field "$id" state)" = "done" ] || fail "a clean exit is done, got $(field "$id" state)"
[ "$(field "$id" summary)" = "Filed under Receipts" ] || fail "the summary is the agent's last line"
[ "$(field "$id" question)" = "" ] || fail "no question was asked"
grep -q 'A body line' "$jobs/$id/message.txt" || fail "the message is written to message.txt"
grep -q 'Account address: ada@example.com' "$jobs/$id/prompt.txt" || fail "the prompt names the account"
grep -q 'never print' -i "$jobs/$id/prompt.txt" || fail "the prompt carries the rules"
[ "$(stat -c %a "$jobs/$id")" = "700" ] || fail "the job directory is private"
[ "$(stat -c %a "$jobs/$id/message.txt")" = "600" ] || fail "the message file is private"
grep -q 'I looked at it' "$jobs/$id/output.log" || fail "the output is kept"
[ "$(cat "$jobs/$id/count.txt")" -gt 5 ] || fail "the agent read the prompt on stdin"

# A question is the last line, and is lifted out of the output.
id=$(new_job '{"messageId":"42:INBOX","account":"ada@example.com","folder":"INBOX","command":"echo working; echo \"QUESTION: Reply to Bob, or just file it?\"","prompt":"Handle it","message":"x"}')
wait_state "$id" done failed cancelled
[ "$(field "$id" state)" = "done" ] || fail "a question is not a failure"
[ "$(field "$id" question)" = "Reply to Bob, or just file it?" ] || fail "the question is lifted out: $(field "$id" question)"

# A non-zero exit is failed, with the exit status and the last line.
id=$(new_job '{"messageId":"43:INBOX","account":"a","folder":"f","command":"echo boom >&2; exit 3","prompt":"p","message":"m"}')
wait_state "$id" done failed cancelled
[ "$(field "$id" state)" = "failed" ] || fail "a bad exit is failed"
case "$(field "$id" error)" in *"status 3"*boom*) ;; *) fail "the error names the status and the last line: $(field "$id" error)";; esac

# Cancel stops a running agent and records that it was stopped, not that it failed.
id=$(new_job '{"messageId":"44:INBOX","account":"a","folder":"f","command":"echo started; sleep 30; echo never","prompt":"p","message":"m"}')
wait_state "$id" running
sleep 0.2
python3 "$runner" cancel "$id"
wait_state "$id" cancelled done failed
[ "$(field "$id" state)" = "cancelled" ] || fail "a stopped job is cancelled, got $(field "$id" state)"
grep -q 'never' "$jobs/$id/output.log" && fail "the agent was not allowed to finish"
[ "$(field "$id" summary)" = "started" ] || fail "what it said before the stop is kept"

# Listing returns every job, newest first, as one array.
count=$(python3 "$runner" list | python3 -c 'import json,sys; jobs=json.load(sys.stdin); print(len(jobs)); assert jobs[0]["created"] >= jobs[-1]["created"]')
[ "$count" = "4" ] || fail "list returns every job"

# Refusals: no command, no prompt, or no message id makes no job.
printf '%s\n' '{"messageId":"1","command":"","prompt":"p","message":"m"}' | python3 "$runner" new >/dev/null 2>&1 && fail "an empty command is refused"
printf '%s\n' 'not json' | python3 "$runner" new >/dev/null 2>&1 && fail "junk is refused"
[ "$(python3 "$runner" list | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" = "4" ] || fail "a refusal makes no directory"

# The message never reaches a command line: a message that is itself a shell
# command is a file, and the agent sees it only as text.
id=$(new_job '{"messageId":"45:INBOX","account":"a","folder":"f","command":"tr -d \"\\n\" < message.txt","prompt":"p","message":"$(touch pwned); `touch pwned2`"}')
wait_state "$id" done failed cancelled
[ ! -e "$jobs/$id/pwned" ] && [ ! -e "$jobs/$id/pwned2" ] || fail "message text was executed"
[ "$(field "$id" summary)" = '$(touch pwned); `touch pwned2`' ] || fail "the agent saw the text as text"
echo "test_agent_job.sh ok"
