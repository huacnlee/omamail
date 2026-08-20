QMLLINT := /usr/lib/qt6/bin/qmllint
QML_FILES := Service.qml MailAccount.qml BarWidget.qml App.qml \
	AuthManager.qml GmailApiClient.qml CacheStore.qml \
	ImapAuth.qml ImapClient.qml \
	components/ImapSetupPage.qml \
	components/ProviderPicker.qml \
	components/GmailIcon.qml \
	components/MailboxSidebar.qml \
	components/MailboxTabs.qml \
	components/MessageList.qml \
	components/MessageRow.qml \
	components/MessageMenu.qml \
	components/ActionIcon.qml \
	components/IconButton.qml \
	components/IconTextButton.qml \
  components/ImagePopover.qml \
  components/KeyHints.qml \
	components/MessageReader.qml \
	components/ReaderBlankSlate.qml \
	components/ReaderSkeleton.qml \
	components/ComposeView.qml \
	components/SearchBar.qml \
	components/AppMenu.qml \
	components/AccountSwitcher.qml \
	components/BackBar.qml \
	components/UserBar.qml \
	components/SettingsPage.qml \
	components/SetupPage.qml \
	components/ShortcutHelp.qml

.PHONY: test test-js test-shell qml-check validate

test: test-js test-shell

# The parsing, formatting, and decision rules live in plain JS precisely so
# they can be tested without a compositor. These run anywhere node does.
test-js:
	node tests/test_oauth.js
	node tests/test_credentials.js
	node tests/test_gmail_api.js
	node tests/test_message.js
	node tests/test_html.js
	node tests/test_cache.js
	node tests/test_model.js
	node tests/test_accounts.js
	node tests/test_provider.js
	node tests/test_imap.js

test-shell:
	python3 tests/test_qml_names.py
	python3 tests/test_qml_text_format.py
	bash tests/test_source.sh
	bash tests/test_service_source.sh
	bash tests/test_install.sh
	bash tests/test_transport.sh

# Needs the Omarchy shell's qs.Commons / qs.Ui on the import path.
qml-check:
	$(QMLLINT) -I /usr/share/omarchy/shell $(QML_FILES)

validate: test qml-check
	omarchy plugin validate .
	git diff --check
