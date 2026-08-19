#!/usr/bin/env bash
# Two rules that are easy to break by accident and invisible until someone
# switches to a light theme or the QML engine chokes on modern syntax.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { printf 'test_source.sh: %s\n' "$1" >&2; exit 1; }

# 1. No hard-coded colours in QML. Every colour comes from the active Omarchy
#    theme, or a light theme renders unreadable text.
if grep -nE '(color|Color)\s*:\s*"#[0-9A-Fa-f]{3,8}"' -- *.qml components/*.qml; then
  fail "hard-coded colour in QML: use Color.* or a colour passed in from App.qml"
fi
if grep -nE ':\s*"(red|blue|green|white|black|yellow|orange|purple|gray|grey)"' -- *.qml components/*.qml; then
  fail "named display colour in QML: use Color.* instead"
fi

# 2. The JS libraries are read by the QML engine, which does not accept ES6.
#    tests/ is node-only and exempt.
for file in OAuth.js Credentials.js GmailApi.js Message.js Model.js Html.js; do
  head -1 "$file" | grep -q '^\.pragma library$' || fail "$file must start with .pragma library"
  # Comments quote code with backticks and say things like "a => b", so the
  # check runs on code lines only.
  if grep -vE '^\s*(//|\*|/\*)' "$file" | grep -nE '^\s*(const|let)\s|=>|`'; then
    fail "$file uses ES6 syntax the QML engine will not parse"
  fi
done

# 3. Nothing may name a colour inside a JS library either: colours are passed
#    in from QML, which is the only place that can read the theme.
for file in Html.js Model.js GmailApi.js Message.js; do
  if grep -vE '^\s*(//|\*|/\*)' "$file" | grep -nE '#[0-9A-Fa-f]{6}'; then
    fail "$file names a colour: pass it in from QML instead"
  fi
done

# 4. barForeground is a qs.Ui.Panel property. A BarWidget that reads it gets
#    undefined, and an undefined colour paints nothing at all.
if grep -vE '^\s*//' BarWidget.qml | grep -n 'barForeground'; then
  fail "BarWidget has no barForeground; read bar.foreground instead"
fi

printf 'test_source.sh ok\n'
