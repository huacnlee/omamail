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
# A scope job has no message: the prompt names the account, or every account,
# and `show` returns the job with the tail of what the agent wrote.
id=$(new_job '{"scope":"all","accounts":["ada@example.com","bob@example.com"],"command":"echo one; echo two; echo Found three","prompt":"Find invoices","message":""}')
wait_state "$id" done failed cancelled
[ "$(field "$id" state)" = "done" ] || fail "a scope job runs without a message"
[ "$(field "$id" scope)" = "all" ] || fail "the scope is kept"
grep -q 'Scope: every account. Their addresses: ada@example.com, bob@example.com' "$jobs/$id/prompt.txt" || fail "the prompt names every account"
grep -q 'The message' "$jobs/$id/prompt.txt" && fail "a scope prompt carries no message block"
python3 "$runner" show "$id" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["job"]["id"]==sys.argv[1]; assert d["output"]=="one\ntwo\nFound three\n", repr(d["output"])' "$id" || fail "show returns the job and its output"
id=$(new_job '{"scope":"account:ada@example.com","account":"ada@example.com","command":"true","prompt":"p","message":""}')
wait_state "$id" done failed cancelled
grep -q 'Scope: the account whose address is ada@example.com' "$jobs/$id/prompt.txt" || fail "a one-account scope names it"
printf '%s\n' '{"command":"true","prompt":"p","message":""}' | python3 "$runner" new >/dev/null 2>&1 && fail "no message and no scope is refused"
python3 "$runner" show nope >/dev/null 2>&1 && fail "show refuses an unknown job"
# A continuation: the parent's prompt, what its agent wrote, and the owner's
# answer, all in the new prompt, with the parent's message carried forward.
parent=$(new_job '{"messageId":"46:INBOX","account":"ada@example.com","folder":"INBOX","subject":"Invoice","command":"echo Looked; echo \"QUESTION: Reply to Bob?\"","prompt":"Handle this","message":"From: Bob\n\nPay me"}')
wait_state "$parent" done failed cancelled
child=$(new_job "{\"parent\":\"$parent\",\"command\":\"cat > seen.txt; echo Replied\",\"prompt\":\"Yes, reply and say it is paid\",\"message\":\"\"}")
wait_state "$child" done failed cancelled
[ "$(field "$child" state)" = "done" ] || fail "a continuation runs"
[ "$(field "$child" parent)" = "$parent" ] || fail "the continuation names its parent"
[ "$(field "$child" messageId)" = "46:INBOX" ] || fail "the continuation is about the parent's message"
[ "$(field "$child" subject)" = "Invoice" ] || fail "and keeps its subject"
grep -q 'Pay me' "$jobs/$child/message.txt" || fail "the parent's message is carried forward"
grep -q 'The owner asked:' "$jobs/$child/seen.txt" && grep -q 'QUESTION: Reply to Bob?' "$jobs/$child/seen.txt" \
  && grep -q 'Yes, reply and say it is paid' "$jobs/$child/seen.txt" || fail "the prompt holds the earlier exchange and the answer"
printf '%s\n' '{"parent":"nope","command":"true","prompt":"p","message":""}' | python3 "$runner" new >/dev/null 2>&1 && fail "an unknown parent is refused"

# Several messages: one file each, the prompt numbering them, the job naming every id.
many=$(new_job '{"messages":[{"messageId":"50:INBOX","message":"First body"},{"messageId":"51:INBOX","message":"Second body"}],"account":"ada@example.com","folder":"INBOX","subject":"2 messages","command":"cat > seen.txt; ls message-*.txt | wc -l","prompt":"File both","message":""}')
wait_state "$many" done failed cancelled
[ "$(field "$many" state)" = "done" ] || fail "a selection job runs"
[ "$(field "$many" summary)" = "2" ] || fail "one file per message"
python3 -c 'import json,sys; j=json.load(open(sys.argv[1])); assert j["messageIds"]==["50:INBOX","51:INBOX"], j["messageIds"]' "$jobs/$many/job.json" || fail "every id is on the job"
grep -q 'Message 2 of 2' "$jobs/$many/seen.txt" && grep -q '2 email messages' "$jobs/$many/seen.txt" || fail "the prompt numbers the messages"

# The listing carries the agent's last line while it runs, and a tail that
# looks like a permission prompt and stays still is reported as a stall.
slow=$(new_job '{"messageId":"60:INBOX","command":"echo Reading the message; sleep 1.5; echo \"Allow Bash(himalaya envelope list)? (y/n)\"; sleep 40","prompt":"p","message":"m"}')
wait_state "$slow" running
sleep 0.8
python3 "$runner" list | python3 -c 'import json,sys; j=[x for x in json.load(sys.stdin) if x["id"]==sys.argv[1]][0]; assert j["progress"]=="Reading the message", j.get("progress")' "$slow" || fail "the listing carries the last line as progress"
for _ in $(seq 1 200); do [ "$(field "$slow" stall)" = "permission" ] && break; sleep 0.1; done
[ "$(field "$slow" stall)" = "permission" ] || fail "a still prompt-shaped tail is a permission stall"
[ "$(field "$slow" state)" = "running" ] || fail "a stalled job is still running, so it can be cancelled"
python3 "$runner" cancel "$slow"
wait_state "$slow" cancelled
[ "$(field "$slow" stall)" = "" ] || fail "a finished job carries no stall"
# Forgetting removes a finished job and refuses a running one.
count_before=$(python3 "$runner" list | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
python3 "$runner" forget "$many" || fail "a finished job can be forgotten"
[ ! -e "$jobs/$many" ] || fail "the job directory is gone"
[ "$(python3 "$runner" list | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" = "$((count_before - 1))" ] || fail "and it left the listing"
busy=$(new_job '{"messageId":"70:INBOX","command":"sleep 30","prompt":"p","message":"m"}')
wait_state "$busy" running
python3 "$runner" forget "$busy" >/dev/null 2>&1 && fail "a running job is not forgotten"
[ -e "$jobs/$busy/job.json" ] || fail "and stays on disk"
python3 "$runner" cancel "$busy"; wait_state "$busy" cancelled
python3 "$runner" forget nope >/dev/null 2>&1 && fail "an unknown job is refused"
echo "test_agent_job.sh ok"
