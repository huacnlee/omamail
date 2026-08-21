QMLLINT := /usr/lib/qt6/bin/qmllint
QML_FILES := Service.qml BarWidget.qml App.qml \
	account/MailAccount.qml \
	cache/CacheStore.qml cache/BodyCache.qml \
	providers/AuthManager.qml providers/GmailApiClient.qml \
	providers/ImapAuth.qml providers/ImapClient.qml \
	components/ImapSetupPage.qml \
	components/ProviderPicker.qml \
	components/GmailIcon.qml \
	components/MailboxSidebar.qml \
	components/MailboxTabs.qml \
	components/MessageList.qml \
	components/ListSkeleton.qml \
	components/MessageRow.qml \
	components/MessageMenu.qml \
	components/MenuActionRow.qml components/MenuSeparatorLine.qml \
	components/KeyRouter.qml \
	components/ActionIcon.qml \
	components/IconButton.qml \
	components/IconTextButton.qml \
  components/ImagePopover.qml \
  components/KeyHints.qml \
	components/MessageReader.qml \
	components/ReaderNotice.qml \
	components/InviteCard.qml \
	components/ReaderBlankSlate.qml \
	components/ReaderSkeleton.qml \
	components/ComposeView.qml \
	components/SearchBar.qml \
	components/AppMenu.qml \
	components/AccountSwitcher.qml \
	components/AccountRemovalDialog.qml \
	components/BackBar.qml \
	components/UserBar.qml \
	components/SettingsPage.qml \
	components/SetupPage.qml \
	components/ShortcutHelp.qml

.PHONY: test test-js test-shell test-qml qml-check validate bench

test: test-js test-shell test-qml

# The parsing, formatting, and decision rules live in plain JS precisely so
# they can be tested without a compositor. These run anywhere node does.
test-js:
	node tests/test_oauth.js
	node tests/test_credentials.js
	node tests/test_gmail_api.js
	node tests/test_message.js
	node tests/test_calendar.js
	node tests/test_unsubscribe.js
	node tests/test_html.js
	node tests/test_cache.js
	node tests/test_model.js
	node tests/test_keymap.js
	node tests/test_accounts.js
	node tests/test_menu.js
	node tests/test_provider.js
	node tests/test_imap.js

test-shell:
	python3 tests/test_qml_names.py
	python3 tests/test_qml_text_format.py
	bash tests/test_source.sh
	bash tests/test_service_source.sh
	bash tests/test_install.sh
	bash tests/test_transport.sh

# Focus ownership and key routing cannot be tested without a focus scope, and a
# focus scope needs the QML engine. Offscreen, so it needs no compositor: the
# bugs this catches — a hidden component owning the focus and swallowing keys, a
# Repeater building no Shortcuts — are invisible to any test that cannot
# instantiate one.
#
# Found rather than hard-coded: the binary is at /usr/lib/qt6/bin on Arch and on
# PATH as qmltestrunner6 on Debian and Ubuntu, and pinning one of those makes
# the suite unrunnable on the other.
QMLTESTRUNNER := $(shell command -v qmltestrunner6 2>/dev/null \
	|| command -v qmltestrunner 2>/dev/null \
	|| ls /usr/lib/qt6/bin/qmltestrunner 2>/dev/null)

test-qml:
	@test -n "$(QMLTESTRUNNER)" || { \
		echo "qmltestrunner not found: install Qt 6 QML test tooling" >&2; \
		echo "  Arch:   qt6-declarative" >&2; \
		echo "  Ubuntu: qt6-declarative-dev-tools qml6-module-qttest" >&2; \
		exit 1; }
	QT_QPA_PLATFORM=offscreen $(QMLTESTRUNNER) -input tests/qml

# Both engines on the same fixtures. The QML column is the one that decides
# anything — the shell runs that engine, not node's — so run it on the machine
# the shell runs on. Not part of `test`: it takes a few seconds and measures
# rather than asserts.
bench:
	bash tests/bench.sh

# Needs the Omarchy shell's qs.Commons / qs.Ui on the import path.
qml-check:
	$(QMLLINT) -I /usr/share/omarchy/shell $(QML_FILES)

validate: test qml-check
	omarchy plugin validate .
	git diff --check
