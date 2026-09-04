# Contributing to Omamail

There is no issue tracker here. Issues are turned off on purpose: a bug report
asks somebody else to reproduce a problem, decide what it means, and find the
time to fix it, and a queue of those grows faster than one project can answer
it. A pull request is the same information with the answer already in it.

Coding agents are why that is a reasonable thing to ask now. Point Codex,
Claude Code, or whatever you use at this checkout, describe what went wrong,
and let it read the code — the working agreements it needs are in
[AGENTS.md](AGENTS.md), which both of those read on their own.

## You found a bug

1. Reproduce it, and write down the smallest way to.
2. Fix it — yourself or with an agent — and add a test that fails without the
   fix.
3. Open a pull request whose body contains the reproduction. That is where the
   bug report lives now, next to the change that ends it.

**If you cannot fix it**, open a draft pull request that contains a failing
test and nothing else. A failing test is a bug report that cannot be
misunderstood, cannot go stale, and tells whoever picks it up when they are
done.

**A security fault is the exception.** Do not publish a working exploit in a
pull request. Report it privately first — GitHub's *Report a vulnerability*
button on the repository's Security tab — and send the fix afterwards, or with
it, described in terms of what it protects rather than what it opens.

## Before you write anything

- [AGENTS.md](AGENTS.md) is the working agreement: colours, layout, focus and
  keys, providers, secrets. Most of it exists because the obvious thing was
  tried and was wrong, and each rule says which. Read the section you are about
  to touch.
- [docs/SPEC.md](docs/SPEC.md) is what the app is meant to do,
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) how it is put together,
  [docs/KEYS.md](docs/KEYS.md) the key design — read that one before touching a
  binding.

## Project boundary

Omamail is a [Quickshell plugin hosted by `omarchy-shell`][omarchy-shell]. Changes should extend that plugin's service or interface, not turn this repository into a second application.

Helper scripts that let the plugin perform its own work belong here. A standalone CLI, agent skill, daemon, SDK, or other independently consumed interface does not. The plugin must not install commands or integrations into global user paths when it loads. Omarchy's plugin installer deliberately [clones and validates plugins, and can enable them, without running installation hooks][plugin-installation].

Programmatic access to mail may be useful, but it needs an integration boundary designed independently from the Quickshell plugin. Omarchy defines [IPC as the standard boundary for commands that communicate with the running shell][shell-ipc]; proposals that need a different lifecycle or ownership model should begin with a design discussion.

[omarchy-shell]: https://github.com/omacom/omarchy/blob/quattro/docs/omarchy-shell.md
[plugin-installation]: https://github.com/omacom/omarchy/blob/quattro/manual/32-shell-plugins.md#adding-a-plugin-from-git
[shell-ipc]: https://github.com/omacom/omarchy/blob/quattro/docs/omarchy-shell.md#ipc

```bash
make install     # symlink this checkout into ~/.config/omarchy/plugins
make validate    # node tests, source regressions, QML tests, qmllint, manifest
```

`make validate` needs `node`, `python3`, Qt 6 QML test tooling
(`qt6-declarative` on Arch, `qt6-declarative-dev-tools` and
`qml6-module-qttest` on Debian and Ubuntu) and the `omarchy` CLI. It has to be
green before you open the pull request, and green on your machine — nothing in
CI runs it for you.

## How the change gets made

In this order, and none of the steps fold into each other:

1. **Implement it.** One change, finished — not a sketch with the hard half
   left for review to find.
2. **Test it, then test it again.** Run `make validate` until it is green, run
   the new test against the unfixed code and watch it fail, and exercise the
   real path by hand. A suite that passed once on a machine that has since
   changed is not evidence; run it again before you open the pull request, and
   again after every round of review.
3. **Have a fresh agent review it.** Open a *new* agent — an empty context,
   nothing of the conversation that wrote the code — hand it the diff and
   `AGENTS.md`, and ask it to find what is wrong. The agent that wrote a patch
   is the worst reviewer of it: it already believes the reasoning, so it reads
   the code it meant to write. Fix what the review finds, or write down why it
   is not a fault.
4. **Then open the pull request.**

## Tests

A change without a test that fails without it is not finished. Where one goes:

| What you changed | Where the test goes |
|------------------|---------------------|
| Parsing, formatting, or a decision rule in `.js` | `tests/test_*.js`, run by `node` — no compositor needed |
| A script in `scripts/` | `tests/test_*.sh` or `tests/test_*.py` |
| Focus, key routing, layout, or anything needing the QML engine | `tests/qml/tst_*.qml`, run offscreen |
| A rule that grep can enforce — no literal colours, no `LayoutMirroring` | `tests/test_source.sh` |

Add the new file to the `Makefile` in the same commit; a test nothing runs is
not a test. Assert the fault, not the fix: run the new test against the old
code once and watch it fail, and say so in the pull request.

## If you touched the interface

- Follow the **omarchy-style** skill's guidance — Omamail is an Omarchy
  application before it is a mail client, and its look is not a matter of taste
  per pull request. If your agent does not carry that skill, take the existing
  components as the specification and change nothing about the visual language
  that the change did not require. `AGENTS.md`'s *Colors*, *UI labels* and
  *Popups* sections are the same rules where they are specific to this
  codebase, and `tests/test_source.sh` enforces the part of them that grep can.
- **Test it on a screen, by hand. This is required and nothing substitutes for
  it.** `make install` symlinks this checkout into
  `~/.config/omarchy/plugins`, so QML edits are read live; click the envelope
  in the bar and drive the change with the mouse and with the keyboard, in a
  light theme and in a dark one, and at both window sizes — three columns and
  mini. The offscreen QML tests prove focus and routing; they cannot see that a
  control hangs four pixels out of its row, and that is the class of bug that
  reaches users.
- Put a screenshot in the pull request, and say which themes and sizes you
  drove it in.

## The pull request

**One change per pull request.** A refactor travelling with a bug fix makes the
fix impossible to review and impossible to revert on its own.

**The title is the commit message.** Merges here are squashes, so the title you
write becomes the line in `git log` with `(#123)` appended, and it is read by
people looking for when something changed. Write a sentence in the imperative,
sentence case, naming what is different afterwards — no `fix:` or `feat:`
prefix:

```
Read a body as UTF-8 when the bytes say so and the header does not
Find Exchange's Junk folder by the name Exchange gives it
Keep an attachment, not only open it once
```

Not `fix imap bug`, not `Update ImapClient.qml`.

**The body is prose, with two headings that are read by a machine.** Say what
was wrong and why this is the fix; a paragraph of reasoning is worth more than
a bulleted diff summary, and the surprising part is the part to spend words on.
Then:

````markdown
## Verification

`make validate` green. `tests/test_message.js` covers the 8-bit body with an
accent in it, and fails with the change reverted. Live: a Fastmail mailbox
whose French subjects rendered as mojibake before and read correctly after.

## Release Notes

- Accented characters in message bodies no longer render as mojibake.
````

`## Verification` names the commands you ran and what they said. Measured, not
inferred: "should work" is not verification, and neither is a test you did not
watch fail. Four things belong in it, and a reviewer will ask for any that is
missing:

- `make validate`, and that it was green on the commit you are sending.
- The new test, and that you saw it fail against the unfixed code.
- What you drove by hand — for an interface change, the themes and sizes, with
  a screenshot.
- That a fresh agent reviewed the diff, and what it found. "Nothing" is an
  answer; not having asked is not.

`## Release Notes` is lifted verbatim by `scripts/release-notes.sh` into the
GitHub release for the version that ships it — the heading is matched exactly,
so spell it that way. Write the bullets for somebody reading a changelog, in
terms of their mail, not the code: what they could not do before and can now.
Leave the section out only when nothing a user can see changed — a test, a
document, an internal rename.

## Review

Answer a review comment by changing the code or by saying why the change would
be wrong, and re-run `make validate` after every round — a fix made under
review is a change like any other. Both answers are useful; silence and a
force-push are not.

If an agent wrote the patch, you are still its author: read the diff before you
send it, and be able to explain any line in it.
