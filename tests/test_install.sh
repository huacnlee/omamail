#!/usr/bin/env bash
# The manifest is the contract with the shell. Every entry point it names has
# to exist, or the plugin loads halfway and fails at the moment the user
# clicks something.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { printf 'test_install.sh: %s\n' "$1" >&2; exit 1; }

python3 -c "import json; json.load(open('manifest.json'))" || fail "manifest.json is not valid JSON"

kinds=$(python3 -c "import json; print(' '.join(json.load(open('manifest.json'))['kinds']))")
for kind in service bar-widget panel; do
  case " $kinds " in *" $kind "*) ;; *) fail "manifest kinds must include $kind" ;; esac
done

for entry in service:Service.qml barWidget:BarWidget.qml panel:App.qml; do
  key=${entry%%:*}
  file=${entry##*:}
  declared=$(python3 -c "import json; print(json.load(open('manifest.json'))['entryPoints'].get('$key',''))")
  [ "$declared" = "$file" ] || fail "entryPoints.$key must be $file, found '$declared'"
  [ -f "$file" ] || fail "$file is declared in the manifest but does not exist"
done

[ -x install.sh ] || fail "install.sh must be executable"
grep -q 'plugin-backups' install.sh || fail "backups must not land inside the plugins directory"

test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/config/omarchy-gmail" "$test_root/cache/omarchy-gmail"
printf 'client\n' > "$test_root/config/omarchy-gmail/credentials.json"
printf 'cache\n' > "$test_root/cache/omarchy-gmail/inbox.json"
XDG_CONFIG_HOME="$test_root/config" XDG_CACHE_HOME="$test_root/cache" \
  sh scripts/migrate-storage.sh
[ -f "$test_root/config/omamail/credentials.json" ] || fail "legacy config was not moved"
[ -f "$test_root/cache/omamail/inbox.json" ] || fail "legacy cache was not moved"
[ ! -e "$test_root/config/omarchy-gmail" ] || fail "legacy config directory remains"
[ ! -e "$test_root/cache/omarchy-gmail" ] || fail "legacy cache directory remains"

# The keyring helper takes attribute pairs now, because keying a refresh token
# on the OAuth client alone lets two accounts sharing one client overwrite each
# other. An empty value is a secret-tool wildcard, so it is refused outright.
for bad in "" "a" "client-id "; do
  if printf 'token\n' | sh scripts/keyring-store.sh $bad >/dev/null 2>&1; then
    fail "keyring-store.sh accepted a malformed attribute list: '$bad'"
  fi
done

printf 'test_install.sh ok\n'
