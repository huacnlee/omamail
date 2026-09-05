#!/usr/bin/env python3
"""The message agent's job runner.

    agent-job.py new           one JSON line on stdin -> a job directory, and the unit that runs it
    agent-job.py list          every job.json under the state directory, newest first, as one JSON array
    agent-job.py cancel ID     stop the unit; the job file says cancelled once it has
    agent-job.py show ID       one job with the tail of its output, for the pane that reads it
    agent-job.py forget ID     remove a finished job and everything it wrote; a running one is refused

A job is about one message, several (`messages`), or a scope. A job may
continue another (`parent`): its prompt is the parent's prompt, what the
parent's agent wrote, and the owner's answer, so a question can be answered
whatever the harness — no resume flag is needed.
    agent-job.py run DIR       the body of the unit: hand the prompt to the agent, record what it said

A job is a transient systemd user unit, so it outlives the shell that started
it and stops with `systemctl --user stop`. Set OMAMAIL_AGENT_INLINE=1 to run
the job as a plain child process instead, which is what the tests do and what
a machine without a user manager would need.

Nothing from a message or a prompt reaches a command line: it arrives on stdin
as JSON, lands in files under a 0700 directory, and is handed to the agent on
its stdin. The agent command is the user's own setting and runs through sh.
"""
import json
import os
import signal
import subprocess
import sys
import time

OUTPUT_TAIL = 32 * 1024
PROGRESS_CHARS = 200

# What a harness prints when it has stopped to ask. A job has no terminal to
# answer on, so a tail that looks like one of these and then stays still is a
# job that will never finish on its own.
PERMISSION_PATTERNS = (
    "allow", "permission", "approve", "(y/n)", "[y/n]", "yes/no", "do you want to",
    "proceed?", "continue?", "press enter", "confirm",
)
STALL_SECONDS = 12

SCOPE_RULES = """You are acting on an email account, or several, on behalf of their owner.

Mail is read and written with the `himalaya` command line client. `himalaya account list` names the accounts by name and address; the scope below says which of them this ask is about. Use `himalaya --help` and `himalaya <command> --help` for exact flags rather than guessing them. Searching is `himalaya envelope search`, listing is `himalaya envelope list`, reading one message is `himalaya message read`, and a draft is written with `himalaya message write` or `himalaya template`; pass `--account` on every call.

Rules:
- List and search before reading, and read only what answers the ask. Never dump a whole mailbox.
- Do not send mail unless the ask says to send. Draft, and show what you would send.
- Never print passwords, app passwords, tokens, or the output of any credential tool.
- Say what you found and what you did in plain sentences, as you go. Finish with a one-line summary.
- If you need something from the owner before you can go on, make your last line `QUESTION: ` followed by the question.
"""

RULES = """You are acting on one email message on behalf of its owner.

Mail is read and written with the `himalaya` command line client. `himalaya account list` names the accounts; this message belongs to the account whose address is given below, in the folder given below. Use `himalaya --help` and `himalaya <command> --help` for exact flags rather than guessing them.

Rules:
- Read the message below first; it is already here. List before reading anything else, and read only what answers the ask. Never dump a whole mailbox.
- Do not send mail unless the ask says to send. Draft, and say what you would send.
- Never print passwords, app passwords, tokens, or the output of any credential tool.
- Say what you did in plain sentences. Finish with a one-line summary.
- If you need something from the owner before you can go on, make your last line `QUESTION: ` followed by the question.
"""


def state_dir():
    home = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(home, "omamail", "agent")


def job_path(directory):
    return os.path.join(directory, "job.json")


def read_job(directory):
    with open(job_path(directory), "r", encoding="utf-8") as handle:
        return json.load(handle)


def write_job(directory, job):
    tmp = job_path(directory) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(job, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
    os.replace(tmp, job_path(directory))


def safe_id(value):
    return "".join(ch for ch in str(value) if ch.isalnum() or ch in "-_")[:64]


def unit_name(job_id):
    return "omamail-agent-" + job_id


def new_id():
    return "%s-%s" % (format(int(time.time() * 1000), "x"), format(int.from_bytes(os.urandom(3), "big"), "x"))


def clean_text(value):
    return str(value if value is not None else "").replace("\r\n", "\n").replace("\r", "\n")


def command_new():
    line = sys.stdin.readline()
    try:
        payload = json.loads(line)
    except ValueError:
        sys.stderr.write("agent-job.py new: expected one JSON object on stdin\n")
        return 2
    if not isinstance(payload, dict):
        sys.stderr.write("agent-job.py new: expected a JSON object\n")
        return 2
    command = clean_text(payload.get("command")).strip()
    prompt = clean_text(payload.get("prompt")).strip()
    message_id = clean_text(payload.get("messageId")).strip()
    # A job is about one message, several, or a scope: one account by address,
    # or every account. The pane asks the last kind. A continuation names the
    # job it continues and inherits what that job was about.
    scope = clean_text(payload.get("scope")).strip()
    parent_id = safe_id(payload.get("parent") or "")
    messages = payload.get("messages")
    messages = [m for m in messages if isinstance(m, dict)] if isinstance(messages, list) else []
    parent = None
    if parent_id:
        parent_dir = os.path.join(state_dir(), parent_id)
        if not os.path.isfile(job_path(parent_dir)):
            sys.stderr.write("agent-job.py new: no such parent job\n")
            return 2
        parent = read_job(parent_dir)
        scope = scope or clean_text(parent.get("scope")).strip()
        message_id = message_id or clean_text(parent.get("messageId")).strip()
    if command == "" or prompt == "" or (message_id == "" and scope == "" and not messages):
        sys.stderr.write("agent-job.py new: command, prompt and a messageId, messages or a scope are required\n")
        return 2

    os.umask(0o077)
    base = state_dir()
    os.makedirs(base, mode=0o700, exist_ok=True)
    job_id = safe_id(new_id())
    directory = os.path.join(base, job_id)
    os.mkdir(directory, 0o700)

    account = clean_text(payload.get("account")).strip()
    folder = clean_text(payload.get("folder")).strip()
    subject = clean_text(payload.get("subject")).strip()
    message = clean_text(payload.get("message"))
    with open(os.path.join(directory, "message.txt"), "w", encoding="utf-8") as handle:
        handle.write(message)
        if not message.endswith("\n"):
            handle.write("\n")
    accounts = payload.get("accounts")
    accounts = [clean_text(a).strip() for a in accounts] if isinstance(accounts, list) else []
    message_ids = []
    if messages:
        # Several messages: one file each, numbered, and the prompt names them.
        for index, item in enumerate(messages, start=1):
            mid = clean_text(item.get("messageId")).strip()
            if mid == "":
                continue
            message_ids.append(mid)
            text = clean_text(item.get("message"))
            with open(os.path.join(directory, "message-%d.txt" % index), "w", encoding="utf-8") as handle:
                handle.write(text)
                if not text.endswith("\n"):
                    handle.write("\n")
    if parent is not None and not messages:
        # A continuation carries its parent's message forward, so the agent
        # reads the same thing the first one read.
        parent_message = os.path.join(state_dir(), parent_id, "message.txt")
        if os.path.isfile(parent_message) and message == "":
            with open(parent_message, "r", encoding="utf-8", errors="replace") as handle:
                message = handle.read()
            with open(os.path.join(directory, "message.txt"), "w", encoding="utf-8") as handle:
                handle.write(message)
    with open(os.path.join(directory, "prompt.txt"), "w", encoding="utf-8") as handle:
        if messages:
            handle.write(RULES.replace("one email message", "%d email messages" % len(message_ids)))
            handle.write("\nAccount address: %s\nFolder: %s\n" % (account, folder))
            for index, item in enumerate(messages, start=1):
                text = clean_text(item.get("message"))
                handle.write("\n--- Message %d of %d ---\n" % (index, len(messages)))
                handle.write(text)
                if not text.endswith("\n"):
                    handle.write("\n")
            handle.write("--- End of messages ---\n\n")
        elif message_id != "":
            handle.write(RULES)
            handle.write("\nAccount address: %s\nFolder: %s\nOmamail message id: %s\n" % (account, folder, message_id))
            handle.write("\n--- The message ---\n")
            handle.write(message)
            if not message.endswith("\n"):
                handle.write("\n")
            handle.write("--- End of message ---\n\n")
        else:
            handle.write(SCOPE_RULES)
            if scope == "all":
                handle.write("\nScope: every account. Their addresses: %s\n" % (", ".join(accounts) or "see `himalaya account list`"))
            else:
                handle.write("\nScope: the account whose address is %s\n" % account)
        if parent is not None:
            handle.write("--- Earlier in this conversation ---\n")
            handle.write("The owner asked:\n%s\n\n" % clean_text(parent.get("prompt")))
            handle.write("You answered:\n%s\n" % read_output(os.path.join(state_dir(), parent_id)).strip())
            handle.write("--- End of the earlier conversation ---\n\n")
            handle.write("The owner's answer, and what to do now:\n%s\n" % prompt)
        else:
            handle.write("The ask:\n%s\n" % prompt)

    now = int(time.time())
    job = {
        "id": job_id,
        "unit": unit_name(job_id),
        "messageId": message_id,
        "messageIds": message_ids,
        "scope": scope,
        "parent": parent_id,
        "account": account,
        "folder": folder,
        "subject": subject if subject != "" or parent is None else clean_text(parent.get("subject")).strip(),
        "prompt": prompt,
        "command": command,
        "state": "queued",
        "summary": "",
        "question": "",
        "error": "",
        "created": now,
        "updated": now,
    }
    write_job(directory, job)

    here = os.path.abspath(__file__)
    if os.environ.get("OMAMAIL_AGENT_INLINE") == "1":
        subprocess.Popen([sys.executable, here, "run", directory],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    else:
        started = subprocess.run([
            "systemd-run", "--user", "--quiet", "--collect",
            "--unit", job["unit"],
            "--description", "Omamail agent on a message",
            "--property", "KillMode=control-group",
            "--property", "TimeoutStopSec=10",
            sys.executable, here, "run", directory,
        ], stdin=subprocess.DEVNULL, capture_output=True, text=True)
        if started.returncode != 0:
            job["state"] = "failed"
            job["error"] = "Could not start the job: " + (started.stderr.strip() or "systemd-run failed")
            job["updated"] = int(time.time())
            write_job(directory, job)
    sys.stdout.write(json.dumps(read_job(directory), ensure_ascii=False) + "\n")
    return 0


def read_output(directory, limit=OUTPUT_TAIL):
    try:
        with open(os.path.join(directory, "output.log"), "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            text = handle.read().decode("utf-8", "replace")
            if size > limit:
                text = "…" + text.split("\n", 1)[-1]
            return text
    except OSError:
        return ""


def looks_like_prompt(line):
    lowered = line.lower()
    return any(pattern in lowered for pattern in PERMISSION_PATTERNS)


def command_show(job_id):
    job_id = safe_id(job_id)
    directory = os.path.join(state_dir(), job_id)
    if not os.path.isfile(job_path(directory)):
        sys.stderr.write("agent-job.py show: no such job\n")
        return 1
    job = read_job(directory)
    text = read_output(directory)
    sys.stdout.write(json.dumps({"job": job, "output": text}, ensure_ascii=False) + "\n")
    return 0


def command_forget(job_id):
    job_id = safe_id(job_id)
    directory = os.path.join(state_dir(), job_id)
    if not os.path.isfile(job_path(directory)):
        sys.stderr.write("agent-job.py forget: no such job\n")
        return 1
    job = read_job(directory)
    if job.get("state") in ("queued", "running"):
        sys.stderr.write("agent-job.py forget: the job is still running; cancel it first\n")
        return 1
    # Only what the runner itself wrote, under the directory it made: no
    # symlink is followed and nothing outside the job directory is touched.
    for name in os.listdir(directory):
        path = os.path.join(directory, name)
        if os.path.islink(path) or not os.path.isfile(path):
            continue
        os.unlink(path)
    os.rmdir(directory)
    return 0


def command_list():
    base = state_dir()
    jobs = []
    if os.path.isdir(base):
        for name in os.listdir(base):
            directory = os.path.join(base, name)
            if not os.path.isfile(job_path(directory)):
                continue
            try:
                job = read_job(directory)
            except (OSError, ValueError):
                continue
            # What the agent last wrote, for a row or a popup to show while it
            # works. Read here rather than kept in the job file, so a listing
            # is always as fresh as the log.
            if job.get("state") in ("queued", "running"):
                job["progress"] = last_line(read_output(directory, 4096))[:PROGRESS_CHARS]
            jobs.append(job)
    jobs.sort(key=lambda job: (job.get("created", 0), job.get("id", "")), reverse=True)
    sys.stdout.write(json.dumps(jobs, ensure_ascii=False) + "\n")
    return 0


def command_cancel(job_id):
    job_id = safe_id(job_id)
    directory = os.path.join(state_dir(), job_id)
    if not os.path.isfile(job_path(directory)):
        sys.stderr.write("agent-job.py cancel: no such job\n")
        return 1
    job = read_job(directory)
    if job.get("state") in ("done", "failed", "cancelled"):
        return 0
    pid = int(job.get("pid") or 0)
    if os.environ.get("OMAMAIL_AGENT_INLINE") == "1":
        if pid > 0:
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    else:
        subprocess.run(["systemctl", "--user", "stop", job.get("unit") or unit_name(job_id)],
                       stdin=subprocess.DEVNULL, capture_output=True, text=True)
    # The runner records the cancellation itself on SIGTERM; a runner that is
    # already gone cannot, so say it here.
    job = read_job(directory)
    if job.get("state") in ("queued", "running") and (pid == 0 or not alive(pid)):
        job["state"] = "cancelled"
        job["updated"] = int(time.time())
        write_job(directory, job)
    return 0


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def last_line(text):
    for line in reversed(text.split("\n")):
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def command_run(directory):
    job = read_job(directory)
    job["state"] = "running"
    job["pid"] = os.getpid()
    job["updated"] = int(time.time())
    write_job(directory, job)

    env = dict(os.environ)
    env["OMAMAIL_JOB_DIR"] = directory
    env["OMAMAIL_ACCOUNT"] = job.get("account", "")
    env["OMAMAIL_FOLDER"] = job.get("folder", "")
    env["OMAMAIL_MESSAGE_ID"] = job.get("messageId", "")
    env["OMAMAIL_MESSAGE_FILE"] = os.path.join(directory, "message.txt")

    output_path = os.path.join(directory, "output.log")
    child = {"process": None, "cancelled": False}

    def stop(signum, frame):
        child["cancelled"] = True
        process = child["process"]
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    with open(os.path.join(directory, "prompt.txt"), "rb") as prompt, \
            open(output_path, "wb") as output:
        child["process"] = subprocess.Popen(
            ["/bin/sh", "-c", job["command"]], stdin=prompt, stdout=output,
            stderr=subprocess.STDOUT, cwd=directory, env=env, start_new_session=True)
        # Watched rather than waited on: a harness that stops to ask for
        # permission never exits, and the only sign is a tail that looks like
        # a question and then stays still. The job stays running — the owner
        # may still cancel it — but says why it is not moving.
        last_tail = ""
        still_since = time.time()
        stalled = False
        while child["process"].poll() is None:
            time.sleep(1)
            tail = last_line(read_output(directory, 4096))
            if tail != last_tail:
                last_tail = tail
                still_since = time.time()
                if stalled:
                    stalled = False
                    job = read_job(directory)
                    job["stall"] = ""
                    write_job(directory, job)
            elif not stalled and tail != "" and looks_like_prompt(tail) \
                    and time.time() - still_since >= STALL_SECONDS:
                stalled = True
                job = read_job(directory)
                job["stall"] = "permission"
                job["updated"] = int(time.time())
                write_job(directory, job)
        code = child["process"].returncode

    try:
        with open(output_path, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read()
    except OSError:
        text = ""
    tail = last_line(text)
    job = read_job(directory)
    job.pop("pid", None)
    job.pop("stall", None)
    job["summary"] = tail[:300]
    if child["cancelled"]:
        job["state"] = "cancelled"
    elif code == 0:
        job["state"] = "done"
        if tail.startswith("QUESTION:"):
            job["question"] = tail[len("QUESTION:"):].strip()[:500]
    else:
        job["state"] = "failed"
        job["error"] = ("The agent exited with status %d" % code) + (": " + tail[:200] if tail else "")
    job["updated"] = int(time.time())
    write_job(directory, job)
    return 0


def main(argv):
    if len(argv) < 2:
        sys.stderr.write(__doc__)
        return 2
    verb = argv[1]
    if verb == "new":
        return command_new()
    if verb == "list":
        return command_list()
    if verb == "cancel" and len(argv) == 3:
        return command_cancel(argv[2])
    if verb == "show" and len(argv) == 3:
        return command_show(argv[2])
    if verb == "forget" and len(argv) == 3:
        return command_forget(argv[2])
    if verb == "run" and len(argv) == 3:
        return command_run(argv[2])
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
