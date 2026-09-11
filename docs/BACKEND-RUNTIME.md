# Plugin-owned backend

Omarchy's Plugin Marketplace owns the checkout and its UI. Omamail keeps exactly
one executable at `<plugin root>/runtime/bin/omamail`. The root `backend-version`
file requires an exact version, independent of PATH and system packages. Service
starts one persistent `omamail serve` process over stdin/stdout and checks its
exact binary version, protocol and API revision before dispatching migrated calls.
The plugin-local `backend-api.json` describes its required API; it is not fetched
from main or from a latest-release endpoint.

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

## Stable API and old plugins

`backend-version` belongs to the installed plugin revision. A plugin that has not
been updated continues using that exact private binary, even after main and newer
plugins move on. Neither the app nor Install CLI selects a global or latest backend.
Install CLI only links to the plugin's own executable. Old release tags, binaries,
checksums and API contract assets must remain available and immutable: an old
plugin must also be able to reinstall its pinned version years later. This preserves
the plugin/backend pairing; it cannot guarantee that external mail providers will
never change their services.

There are three independent versions: the plugin manifest version, the exact
backend binary release in `backend-version`, and the integer API revision in
`backend-api.json`. JSON-RPC framing has its own `protocolVersion`. Internal Rust
fixes or optimizations can merge without changing the binary pin or API revision;
users receive those fixes when a later backend release is explicitly pinned.
QML presentation changes can likewise reuse the existing backend.

The contract records the public method inventory and representative request/response
fixtures. Changes to methods, accepted parameters, returned fields, errors or their
meaning require contract review, updated fixtures and a higher API revision. Even an
additive method needs a release before QML can depend on it. Maintain backwards
compatibility where practical, but never use it as a reason to silently replace an
old plugin's binary. `system.info.apiVersion` states the API revision. The initial
published binary 0.9.0 predates this field; only that exact version is recognized as
legacy API 1. Missing revision information from any other version is refused.

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
and `backend-build.json` plus `backend-api.json` are published with both assets only
after both build jobs pass. The release checks the new contract against the pinned
release: a changed contract requires a higher API revision. Each native binary
must also pass the contract runner before packaging.
Both native build jobs produce identical source fingerprints before publication. The new draft
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
protection. That check reads the plugin's exact pin independently of Cargo's
current development version, verifies both published native archives, compares the
published API contract with the PR's contract, and runs `tests/test_backend_api.py`
against each actual published binary using the PR's production QML Wire/Chunks
codecs. It also checks that Rust's public method inventory matches the contract.
A PR cannot satisfy this check merely by building a newer local executable.

Source fingerprints in `backend-build.json` remain release provenance. They bind
both release builds to the same Rust sources, resources and build inputs; they do
not require future PRs to contain identical Rust source. Cargo and Cargo.lock must
still agree for builds, but their development version need not equal the pinned
published binary.

For a combined QML/Rust PR requiring an API change: update the API revision and
contract fixtures, test locally, prepare a new binary version and publish it from
the trusted PR source, then advance `backend-version` after verification. The
required merge check must pass before merging. Publishing after merging would
leave plugin users exposed to the mismatch. Runtime handshake still requires the
exact plugin-local binary pin, even when a newer release reports the same API.

The contract runner currently exercises 13 methods and checks the full advertised
inventory. It covers representative mail processing and cached reader behavior,
not every provider operation or every possible QML argument. API reviewers must
extend fixtures for newly used behavior; passing these tests is not a proof of
complete semantic compatibility. Contract fixtures, API revisions, workflows and
repository policy changes require trusted review. These scripts do not change
repository settings.

Bootstrap status: v0.9.0 contains the optimized x86_64 and aarch64 static
backends. The published packages were checked against the successful native CI
artifacts from f38c2ac; its source fingerprint was added and downloaded again
before advancing the pin. v0.8.2 remains unchanged. The first CI publication
attempt failed because RELEASE_TOKEN lacked permission to create a release;
the release was completed separately. Future automated publication still requires
a contents-write token as described above.

## Local verification

`make install-plugin` removes the old private backend and its local-build marker,
then links and reloads only the plugin. It does not compile or download a backend.
Accounts, drafts and caches are preserved. Use it to test a fresh backend setup:

```sh
make install-plugin
```

Then open Omamail and choose Install backend. Any optional CLI symlink still points
to the same private binary location and works again after installation. Ensure the
shell has no `OMAMAIL_BIN` development override, which would otherwise select that
binary instead of testing the missing-runtime screen.

To try the latest checkout in the desktop, run `make install`. It first builds
with `cargo build --locked --release` into this checkout's `target/` directory,
regardless of `CARGO_TARGET_DIR`, then stages and verifies that binary before
atomically replacing `runtime/bin/omamail`. When its version is ahead of the
release pin, it must match the Git checkout's Cargo package version. The explicit
local installation records a private `runtime/local-build.json` marker binding
that version, the current release pin and the installed binary's SHA-256.
Status and CLI activation accept this local version only while the checkout,
Cargo version, pin and binary bytes still match. No tracked pin is changed.
Only after
that succeeds does it link the plugin and restart the shell. It does not need
published backend assets. Failed builds or version checks preserve the old runtime.

`make install-backend-local` performs only the build and local runtime replacement.
Restart the shell afterwards to replace an already running backend process.
Unset `OMAMAIL_BIN` in the shell's startup environment to use the private runtime.
The separate `scripts/install-backend.sh` command remains the release downloader:
it always uses `backend-version`, ignores the local override when selecting a
release, and clears the marker after verification as part of installation.
Uninstall also removes the marker. Local version overrides require Python 3.11
or newer for Cargo TOML parsing; normal pinned installations do not.

Run `make test-local` on a machine with Rust, Qt 6 test tooling and Quickshell.
It runs the existing Rust, JavaScript, transport/security and offscreen QML
suites, then `make test-backend-process` builds the development executable and
tests the production QML bridge against it using real Quickshell pipes.
The integration test uses temporary HOME/XDG directories and synthetic account
settings. It checks version/protocol handshake, concurrent request correlation,
error responses, credential-free account summaries, a binary message larger
than 1 MiB through upload and response chunks, and confirmed process shutdown.
It does not open the desktop plugin or contact mail providers.

`make test-backend-process` can also be run on its own. These local checks do
not verify live mailbox compatibility, graphical plugin installation, or release
availability. `make qml-check` additionally needs the installed Omarchy shell's
QML imports; inspect its diagnostics even when qmllint returns success.

Local synthetic tests cover archive shape, checksum corruption, version drift,
preparation without pin advancement, pin-only commits and moved-branch refusal.
Historical pre-release checks: a native aarch64 Debian Bookworm container with Rust 1.100.0-nightly
(2026-09-03) passed locked musl tests and a release build; its version probe
returned 0.8.2 and ELF inspection found no interpreter or dynamic section.
The local x86_64 musl test process crashed under Docker emulation. Subsequent
v0.9.0 native Actions builds and published-asset verification supersede that
architecture gap, as recorded above. Future releases still require their own
hosted checks; passing local tests alone is not release availability.
