#!/usr/bin/env bash
# scripts/publish.sh against a real git origin and a recorded fake gh.
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT

mkdir -p "$root/bin"
cat >"$root/bin/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$PUBLISH_TEST_LOG"
case "$1 $2" in
  "auth status") exit 0 ;;
  "api --paginate") exit "${PUBLISH_TEST_API_FAIL:-0}" ;;
  "pr create") echo https://github.com/huacnlee/omamail/pull/123 ;;
  "run list") echo 4242 ;;
  "run watch") exit 0 ;;
  *) exit 2 ;;
esac
GH
chmod +x "$root/bin/gh"
export PATH="$root/bin:$PATH"
export PUBLISH_TEST_LOG="$root/gh.log"

fresh_checkout() {
  rm -rf "$root/origin.git" "$root/clone"
  git init -q --bare "$root/origin.git"
  git init -q -b main "$root/clone"
  git -C "$root/clone" config user.name Tester
  git -C "$root/clone" config user.email tester@example.test
  mkdir -p "$root/clone/scripts" "$root/clone/app"
  cp "$project_dir/scripts/publish.sh" "$project_dir/scripts/bump.sh" \
    "$project_dir/scripts/package-backend.py" "$root/clone/scripts/"
  printf '[package]\nname = "omamail"\nversion = "0.1.0"\n' >"$root/clone/Cargo.toml"
  printf '[[package]]\nname = "omamail"\nversion = "0.1.0"\n' >"$root/clone/Cargo.lock"
  printf '{\n  "version": "0.1.0"\n}\n' >"$root/clone/manifest.json"
  printf 'cmake_minimum_required(VERSION 3.21)\nproject(omamail-app VERSION 0.1.0 LANGUAGES CXX)\n' >"$root/clone/app/CMakeLists.txt"
  printf '__pycache__/\n' >"$root/clone/.gitignore"
  git -C "$root/clone" add -A
  git -C "$root/clone" commit -q -m "Initial"
  git -C "$root/clone" remote add origin "$root/origin.git"
  git -C "$root/clone" push -q -u origin main
  : >"$PUBLISH_TEST_LOG"
}

publish() { (cd "$root/clone" && scripts/publish.sh "$@"); }

refuses() {
  local message="$1"; shift
  local refs_before; refs_before="$(git -C "$root/origin.git" show-ref)"
  if publish "$@" >"$root/out" 2>"$root/err"; then
    echo "publish unexpectedly succeeded: $message" >&2; exit 1
  fi
  grep -F "$message" "$root/err" >/dev/null || { echo "missing refusal: $message" >&2; cat "$root/err" >&2; exit 1; }
  test "$(git -C "$root/origin.git" show-ref)" = "$refs_before" || { echo "refusal still changed the origin" >&2; exit 1; }
  ! grep -q '^run watch' "$PUBLISH_TEST_LOG" || { echo "refusal still watched a run" >&2; exit 1; }
}

# A new version creates only a release branch and PR; main and tags stay untouched.
fresh_checkout
main_sha="$(git -C "$root/clone" rev-parse HEAD)"
publish 0.2.0 >"$root/out"
test "$(git -C "$root/clone" log -1 --format=%s)" = "Version 0.2.0"
test "$(git -C "$root/clone" show --format= --name-only HEAD | sort | tr '\n' ' ')" = "Cargo.lock Cargo.toml app/CMakeLists.txt manifest.json "
grep -F 'version = "0.2.0"' "$root/clone/Cargo.toml" >/dev/null
head_sha="$(git -C "$root/clone" rev-parse HEAD)"
test "$(git -C "$root/origin.git" rev-parse refs/heads/main)" = "$main_sha"
test "$(git -C "$root/origin.git" rev-parse refs/heads/release/0.2.0)" = "$head_sha"
test -z "$(git -C "$root/origin.git" tag)"
test "$(git -C "$root/clone" branch --show-current)" = release/0.2.0
test -z "$(git -C "$root/clone" status --porcelain)"
grep -F 'run watch 4242 --exit-status' "$PUBLISH_TEST_LOG" >/dev/null
! grep -q 'workflow run' "$PUBLISH_TEST_LOG"
grep -F 'https://github.com/huacnlee/omamail/releases/tag/v0.2.0' "$root/out" >/dev/null
grep -F 'pull/123' "$root/out" >/dev/null

# No argument prepares the next patch release.
fresh_checkout
before="$(git -C "$root/clone" rev-parse HEAD)"
publish >"$root/out"
test "$(git -C "$root/origin.git" rev-parse refs/heads/main)" = "$before"
test "$(git -C "$root/clone" branch --show-current)" = release/0.1.1
test -z "$(git -C "$root/origin.git" tag)"

# Refusals, each before anything reaches the origin.
fresh_checkout
echo scratch >"$root/clone/Cargo.toml"
refuses "working tree is not clean" 0.2.0

fresh_checkout
git -C "$root/clone" commit -q --allow-empty -m "Unpushed"
refuses "not in sync with origin/main" 0.2.0

fresh_checkout
git -C "$root/clone" checkout -q -b feature
refuses "on feature, not main" 0.2.0

fresh_checkout
git -C "$root/clone" push -q origin HEAD:refs/tags/v0.2.0
refuses "tag v0.2.0 already exists on origin" 0.2.0

fresh_checkout
refuses "must be newer than 0.1.0" 0.0.9

fresh_checkout
git -C "$root/clone" push -q origin HEAD:refs/heads/release/0.2.0
refuses "release/0.2.0 already exists" 0.2.0

fresh_checkout
PUBLISH_TEST_API_FAIL=1 refuses "cannot list releases" 0.2.0

fresh_checkout
refuses "must be newer than 0.1.0" 0.1.0

# A failed remote read must stop before the otherwise healthy push path.
export PUBLISH_TEST_REAL_GIT="$(command -v git)"
cat >"$root/bin/git" <<'GIT'
#!/usr/bin/env bash
if [ "${PUBLISH_TEST_REMOTE_FAIL:-0}" = 1 ] && [ "$1" = ls-remote ]; then exit 1; fi
exec "$PUBLISH_TEST_REAL_GIT" "$@"
GIT
chmod +x "$root/bin/git"
fresh_checkout
PUBLISH_TEST_REMOTE_FAIL=1 refuses "cannot query remote tags" 0.2.0

for invalid in v0.2.0 00.2.0 '0.2.0;touch injected' $'0.2.0\n'; do
  fresh_checkout
  refuses "expected canonical MAJOR.MINOR.PATCH" "$invalid"
  test ! -e "$root/clone/injected"
done

echo "test_publish: ok"
