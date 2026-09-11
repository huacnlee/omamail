# Plugin-owned backend

Omarchy's Plugin Marketplace owns the checkout and its UI. Omamail keeps exactly
one executable at `<plugin root>/runtime/bin/omamail`. The root `backend-version`
file requires an exact version, independent of PATH and system packages. Service
starts one persistent `omamail serve` process over stdin/stdout and checks its
version and protocol before dispatching migrated calls. `--backend` is an alias.

On a missing or mismatched runtime, the UI explains what is needed. Installation
is explicit; simply loading the plugin never starts a download. From the plugin
directory, `scripts/install-backend.sh` requests the same installation and
`python3 scripts/backend-runtime.py status` reports local state without network
access. Linux x86_64 and aarch64 are supported. Installation downloads only from
the pinned release in `huacnlee/omamail`, verifies SHA256SUMS and the strict archive
layout, checks the candidate executable's version and atomically replaces the
old executable. A failed installation preserves the working runtime. Checksums
protect integrity, not against a compromised publisher.

`python3 scripts/backend-runtime.py enable-cli` explicitly creates
`~/.local/bin/omamail` as a symlink to that same private executable; it refuses
an unrelated file or link. Nothing edits PATH. Run `disable-cli` before removing
the plugin, since Omarchy has no verified uninstall hook for that external link.
`scripts/uninstall-backend.sh` removes the runtime only. Neither operation deletes
accounts, drafts, caches or keyring entries. Marketplace checkouts contain no
symlinks; the optional CLI link is outside the checkout.

For development, `./dev backend` builds the binary and `./dev run` builds then
prints environment and launch instructions. It does not open or restart the
shell. `OMAMAIL_BIN` is an explicit development
path; the installer must never replace that file. Environment changes in your
terminal do not change an already running shell: follow the printed instructions
to make the override available when the shell constructs the plugin, restarting
the shell with that environment when needed. This is not a second Quickshell
application. Rust mail migration remains incomplete; see [BACKEND.md](BACKEND.md).

## Release before pin

Prepare a new version with `scripts/bump.sh MAJOR.MINOR.PATCH`. This edits only
Cargo.toml, the omamail Cargo.lock record and manifest.json. It does not commit,
tag, push or advance backend-version. Review and test the changes, then commit
and push the explicit source branch. For the first release before this workflow
is registered on main, use a branch named `release/backend/<name>`: pushing that
explicit release branch triggers publication. Ordinary feature branches do not
publish automatically. Merge the resulting branch including its bot pin commit,
or review and carry that pin-only commit into the original PR after its actual
published-asset checks pass. Future releases can dispatch Release on main or an
explicit feature branch. A push changing only backend-version does not retrigger
publication, so the bot's pin commit cannot recurse.

The workflow tests and builds locked native musl binaries on Linux x86_64 and
aarch64, executes each version probe, rejects dynamic ELF dependencies, and
packages `omamail-linux-x86_64.tar.gz` and `omamail-linux-aarch64.tar.gz`. Each
contains exactly one regular executable named `omamail`. A combined SHA256SUMS
is published with both assets only after both build jobs pass. The new draft
release is completed, made public, downloaded again and verified before a
follow-up commit changes only backend-version on the release's source branch.

Publication is serialized. Existing releases and tags are never overwritten;
remote lookup errors fail closed. The branch must still equal the dispatch
revision before publication and before the pin commit. A normal fast-forward
push rejects concurrent movement; there is no force push or branch-protection
bypass. If publication succeeds but the branch moves or rejects the pin push,
the release remains published and the pin stays unchanged. Inspect that failure
and verify the already-published assets before preparing a reviewed pin-only
change; rerunning publication refuses the existing version.

Repository setup must provide `RELEASE_TOKEN`, an appropriately scoped GitHub
App token or fine-grained token with contents write permission for this repo,
permitted by branch rules. The default GITHUB_TOKEN cannot be used for the pin
push because it suppresses subsequent workflow triggers. Release runs only by
explicit dispatch or a push to `release/backend/**` of trusted code; restrict
write access to these release branches. PR CI has read-only permissions and never
receives that secret. Require **Published backend merge gate** in branch
protection. That check requires Cargo/lock/manifest/pin equality and downloads
and verifies the actual public release archives. Workflow and repository policy
changes themselves need trusted review. No repository settings are changed by
these scripts.

Bootstrap status: v0.8.2 is already public without backend assets. Do not attach
assets to or overwrite that old release. The implementation retains 0.8.2, so
the merge gate intentionally fails until a new version (for example 0.8.3) is
prepared, published from the feature branch, and pinned after verification.
Publication, credentials and branch protection setup are maintainer operations;
this implementation does not claim they have happened.

Local synthetic tests cover archive shape, checksum corruption, version drift,
preparation without pin advancement, pin-only commits and moved-branch refusal.
A native aarch64 Debian Bookworm container with Rust 1.100.0-nightly
(2026-09-03) passed locked musl tests and a release build; its version probe
returned 0.8.2 and ELF inspection found no interpreter or dynamic section.
The local x86_64 musl test process crashed under Docker emulation, so native
x86_64 execution remains unverified here. Actual Actions publication, both
hosted runner architectures and graphical Omarchy installation remain separate
acceptance checks. Passing local tests is not release availability.
