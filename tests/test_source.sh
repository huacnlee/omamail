#!/usr/bin/env bash
# Two rules that are easy to break by accident and invisible until someone
# switches to a light theme or the QML engine chokes on modern syntax.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { printf 'test_source.sh: %s\n' "$1" >&2; exit 1; }

# Found rather than globbed: the layout groups by module, and a module with no
# QML in it (message/, today) turns a literal glob into a grep error that hides
# whatever the check was meant to say.
#
# A read loop rather than `mapfile`, which is bash 4 and absent from the bash
# 3.2 that macOS still ships — a check that only runs on the deployment target
# is a check nobody runs while writing the code. NUL-separated either way, so a
# path with a space in it stays one path.
QML_FILES=()
while IFS= read -r -d '' found; do QML_FILES+=("$found"); done \
  < <(find . -name '*.qml' -not -path './.git/*' -print0)

JS_FILES=()
while IFS= read -r -d '' found; do JS_FILES+=("$found"); done \
  < <(find . -name '*.js' -not -path './.git/*' -not -path './tests/*' -print0)

# 1. No hard-coded colours in QML. Every colour comes from the active Omarchy
#    theme, or a light theme renders unreadable text.
# gmailRed in ActionIcon is the single declared exception: the M inside the
# Gmail mark is a brand asset, the same carve-out this author's other plugins
# make for an official logo. Everything else takes the theme.
if grep -nE '(color|Color)\s*:\s*"#[0-9A-Fa-f]{3,8}"' -- "${QML_FILES[@]}" \
   | grep -v 'gmailRed'; then
  fail "hard-coded colour in QML: use Color.* or a colour passed in from App.qml"
fi
if grep -nE ':\s*"(red|blue|green|white|black|yellow|orange|purple|gray|grey)"' -- "${QML_FILES[@]}"; then
  fail "named display colour in QML: use Color.* instead"
fi

# 2. The JS libraries are read by the QML engine, which does not accept ES6.
#    tests/ is node-only and exempt.
for file in "${JS_FILES[@]}"; do
  head -1 "$file" | grep -q '^\.pragma library$' || fail "$file must start with .pragma library"
  # Comments quote code with backticks and say things like "a => b", so the
  # check runs on code lines only.
  if grep -vE '^\s*(//|\*|/\*)' "$file" | grep -nE '^\s*(const|let)\s|=>|`'; then
    fail "$file uses ES6 syntax the QML engine will not parse"
  fi
done

# 3. Nothing may name a colour inside a JS library either: colours are passed
#    in from QML, which is the only place that can read the theme.
# Html.js is the one exception, and a narrow one: PAPER and INK are the sheet a
# sender's HTML is printed on. They are content colours, not chrome — a
# message that sets #24292e text needs a light ground under it or it vanishes.
for file in account/Model.js providers/GmailApi.js message/Message.js; do
  if grep -vE '^\s*(//|\*|/\*)' "$file" | grep -nE '#[0-9A-Fa-f]{6}'; then
    fail "$file names a colour: pass it in from QML instead"
  fi
done
if grep -vE '^\s*(//|\*|/\*)' message/Html.js | grep -nE '#[0-9A-Fa-f]{6}' \
   | grep -vE 'PAPER|INK|paperPalette|#1155cc|#5f6368'; then
  fail "message/Html.js may only name the PAPER/INK sheet colours"
fi

# 4. barForeground is a qs.Ui.Panel property. A BarWidget that reads it gets
#    undefined, and an undefined colour paints nothing at all.
if grep -vE '^\s*//' BarWidget.qml | grep -n 'barForeground'; then
  fail "BarWidget has no barForeground; read bar.foreground instead"
fi

# 5. Nothing tracked may be large. This plugin is installed by cloning it, so
#    every megabyte in the tree is a megabyte between the user and a working
#    mailbox — and the things that get big are never the source. A published
#    design canvas with the editor bundled into it was 805 KB of the 1.4 MB a
#    clone cost, for content that was already in the repo beside it as six
#    small files, and an unreferenced screenshot was another 320 KB.
#
#    Anything genuinely large belongs somewhere a clone does not have to carry:
#    a release asset, or GitHub's own attachment host, which is where the
#    README's screenshots already live.
limit=$((128 * 1024))
oversized=$(git ls-files -z \
  | xargs -0 -I{} sh -c 'size=$(wc -c < "{}" 2>/dev/null || echo 0); [ "$size" -gt '"$limit"' ] && printf "%s\t%s\n" "$size" "{}"' \
  || true)
if [ -n "$oversized" ]; then
  printf '%s\n' "$oversized" >&2
  fail "the files above are over 128 KB; keep large assets out of the clone"
fi

printf 'test_source.sh ok\n'
