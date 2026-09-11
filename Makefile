QMLLINT := /usr/lib/qt6/bin/qmllint
QML_FILES := ui/Service.qml ui/BarWidget.qml ui/App.qml ui/compose/RecoveryController.qml \
	ui/backend/Backend.qml ui/backend/Runtime.qml \
	ui/components/BackendSetup.qml ui/components/OmamailLogo.qml \
	ui/account/MailAccount.qml ui/account/BackendSync.qml ui/account/SendQueue.qml ui/account/Intents.qml ui/account/BatchAction.qml ui/account/Rsvp.qml ui/account/LabelActions.qml ui/account/Unsubscribe.qml ui/account/NewMailNotification.qml \
	ui/cache/CacheStore.qml ui/cache/BodyCache.qml \
	ui/providers/AuthManager.qml ui/providers/GmailApiClient.qml \
	ui/providers/OutlookAuth.qml \
	ui/providers/ImapAuth.qml ui/providers/ImapClient.qml \
	ui/providers/HeyAuth.qml ui/providers/HeyClient.qml \
	ui/providers/JmapAuth.qml ui/providers/JmapClient.qml ui/providers/JmapPush.qml \
	ui/components/ImapSetupPage.qml \
	ui/components/OutlookSetupPage.qml \
	ui/components/JmapSetupPage.qml \
	ui/components/HeySetupPage.qml \
	ui/components/ProviderPicker.qml \
	ui/components/GmailIcon.qml \
	ui/components/ProviderLogo.qml \
	ui/components/ProviderHero.qml \
	ui/components/LinkLabel.qml \
	ui/components/MailboxSidebar.qml \
	ui/components/MailboxTabs.qml \
	ui/components/MessageList.qml \
	ui/components/ListSkeleton.qml \
	ui/components/MessageRow.qml \
	ui/components/MessageMenu.qml \
	ui/components/MenuActionRow.qml ui/components/MenuSeparatorLine.qml \
	ui/components/KeyRouter.qml \
	ui/components/WheelScroller.qml \
	ui/components/ActionIcon.qml \
	ui/components/IconButton.qml \
	ui/components/IconTextButton.qml \
	ui/components/ImagePopover.qml \
	ui/components/AttachmentRow.qml \
  ui/components/KeyHints.qml \
	ui/components/MessageReader.qml \
	ui/components/ConversationRail.qml \
	ui/components/ReaderNotice.qml \
	ui/components/InviteCard.qml \
	ui/components/SwitcherSearch.qml \
	ui/components/AccountNameField.qml \
	ui/components/ReaderBlankSlate.qml \
	ui/components/ReaderSkeleton.qml \
	ui/components/ComposeView.qml \
	ui/components/RecipientSuggestions.qml \
	ui/components/ContactsPicker.qml \
	ui/components/LabelPicker.qml \
	ui/components/UndoSendToast.qml \
	ui/components/DraftSavedToast.qml \
	ui/components/SearchBar.qml \
	ui/components/AppMenu.qml \
	ui/components/AccountSwitcher.qml \
	ui/components/AgentPrompt.qml ui/agent/PendingMessages.qml \
	ui/components/LabelMenu.qml \
	ui/components/LabelMovePicker.qml \
	ui/components/NamePrompt.qml \
	ui/components/AddressMenu.qml \
	ui/components/ComposeAgent.qml \
	ui/agent/AgentRunner.qml ui/agent/AgentContext.qml \
	ui/components/AccountRemovalDialog.qml \
	ui/components/BackBar.qml \
	ui/components/SettingsPage.qml \
	ui/components/SettingsSidebar.qml \
	ui/components/CalendarSettings.qml \
	ui/components/CalendarEventComposer.qml \
	ui/components/CalendarEventDetail.qml \
	ui/components/CalendarPalette.qml \
	ui/components/ConfirmDeleteDialog.qml \
	ui/components/SetupPage.qml \
	ui/components/ShortcutHelp.qml \
	ui/calendar/CalendarController.qml ui/calendar/CalendarCache.qml \
	ui/components/CalendarView.qml \
	ui/components/WeekCalendarView.qml \
	ui/bar/BarPreview.qml

.PHONY: test test-js test-shell test-shell-portable test-shell-libcurl \
	test-qml test-local test-backend-process qml-check validate bench install

test: test-rust test-js test-shell test-qml

# The real Quickshell process bridge needs the desktop runtime installed.
# Keep it explicit so the portable suite can still run without Quickshell.
test-local: test test-backend-process

test-backend-process:
	cargo build --locked --target-dir "$(CURDIR)/target" --bin omamail
	python3 tests/test_backend_process.py
	python3 tests/test_agent_native_bridge.py

.PHONY: test-rust backend
test-rust:
	cargo test --locked

backend:
	cargo build --locked --release --target-dir "$(CURDIR)/target" --bin omamail

# The parsing, formatting, and decision rules live in plain JS precisely so
# they can be tested without a compositor. These run anywhere node does.
test-js:
	node ui/tests/test_backend_wire.js
	node ui/tests/test_backend_compatibility.js
	node ui/tests/test_backend_runtime.js
	node ui/tests/test_backend_chunks.js
	node tests/test_imap_backend.js
	node tests/test_hey_backend.js
	node tests/test_gmail_backend.js
	node ui/tests/test_compose_recovery.js
	node ui/tests/test_agent.js
	node ui/tests/test_chat_text.js
	node ui/tests/test_signature.js
	node ui/tests/test_outbox.js
	node ui/tests/test_recipients.js
	node ui/tests/test_senders.js
	node ui/tests/test_oauth.js
	node ui/tests/test_microsoft_oauth.js
	node ui/tests/test_credentials.js
	node ui/tests/test_secrets.js
	node ui/tests/test_gmail_api.js
	node ui/tests/test_message.js
	node ui/tests/test_calendar.js
	node ui/tests/test_calendar_cache.js
	node ui/tests/test_calendar_feed.js
	node ui/tests/test_calendar_sources.js
	node ui/tests/test_calendar_palette.js
	node ui/tests/test_bar_preview.js
	node ui/tests/test_unsubscribe.js
	node ui/tests/test_mailto.js
	node ui/tests/test_html.js
	node ui/tests/test_direction.js
	node ui/tests/test_cache.js
	node ui/tests/test_render_cache.js
	node ui/tests/test_model.js
	node ui/tests/test_icons.js
	node ui/tests/test_navigation.js
	node ui/tests/test_conversation.js
	node tests/test_reader_pipeline.js
	node ui/tests/test_keymap.js
	node ui/tests/test_accounts.js
	node ui/tests/test_unified.js
	node ui/tests/test_aliases.js
	node ui/tests/test_menu.js
	node ui/tests/test_provider.js
	node ui/tests/test_imap.js
	node ui/tests/test_jmap.js
	node ui/tests/test_jmap_threads.js
	node ui/tests/test_jmap_helpers.js
	node ui/tests/test_hey.js

test-shell: test-shell-portable test-shell-libcurl

# Everything here drives one of our own scripts against a fake server and
# asserts what the script did with the answer, so any libcurl can run it.
test-shell-portable:
	python3 tests/test_network_migration.py
	python3 tests/test_plugin_workflow.py
	python3 tests/test_backend_runtime.py
	python3 tests/test_backend_release.py
	python3 tests/test_runtime_release_contract.py
	sh tests/test_dev.sh
	python3 tests/test_attachment_common.py
	python3 tests/test_notification.py
	python3 tests/test_curl_config.py
	python3 tests/test_public_http.py
	python3 tests/test_contacts.py
	python3 tests/test_qml_names.py
	python3 tests/test_qml_text_format.py
	bash tests/test_source.sh
	bash tests/test_service_source.sh
	bash tests/test_config_store.sh
	bash tests/test_agent_job.sh
	bash tests/test_link_plugin.sh
	bash tests/test_mailto.sh
	bash tests/test_transport.sh
	bash tests/test_jmap_transport.sh
	python3 tests/test_jmap_stream.py
	bash tests/test_attachment_open.sh
	bash tests/test_attachment_save.sh
	bash tests/test_attachment.sh
	bash tests/test_calendar_transport.sh
	bash tests/test_calendar_write.sh
	bash tests/test_calendar_delete.sh
	bash tests/test_release_notes.sh

# This one asserts libcurl's own behaviour rather than ours: which of its two
# output channels a single-UID BODY.PEEK fetch arrives on. That is a property
# of the installed libcurl and it differs by version — Omarchy's 8.21 puts the
# message on stdout, and the libcurl on a GitHub runner delivers neither the
# body there nor a complete one through the header callback. Running it on a
# runner reports on a library nobody here runs, which is why the release
# workflow does not, and why `make test` still does.
test-shell-libcurl:
	bash tests/test_imap_ordering.sh

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
	|| ls /usr/lib/qt6/bin/qmltestrunner 2>/dev/null \
	|| command -v qmltestrunner 2>/dev/null)

test-qml:
	@test -n "$(QMLTESTRUNNER)" || { \
		echo "qmltestrunner not found: install Qt 6 QML test tooling" >&2; \
		echo "  Arch:   qt6-declarative" >&2; \
		echo "  Ubuntu: qt6-declarative-dev-tools qml6-module-qttest" >&2; \
		exit 1; }
	cargo build --locked --bin omamail
	python3 tests/run_qml_native.py "$(QMLTESTRUNNER)" -input ui/tests/qml
	python3 tests/test_outlook_http.py "$(QMLTESTRUNNER)"
	python3 tests/test_sidebar_text.py "$(QMLTESTRUNNER)"
	QMLTESTRUNNER="$(QMLTESTRUNNER)" cargo test --locked --lib message::html::tests::native_output_cannot_trigger_qt_resource_requests -- --ignored

# Both engines on the same fixtures. The QML column is the one that decides
# anything — the shell runs that engine, not node's — so run it on the machine
# the shell runs on. Not part of `test`: it takes a few seconds and measures
# rather than asserts.
bench:
	bash ui/tests/bench.sh

# Needs the Omarchy shell's qs.Commons / qs.Ui on the import path.
qml-check:
	$(QMLLINT) -I /usr/share/omarchy/shell $(QML_FILES)

validate: test qml-check
	omarchy plugin validate .
	git diff --check

# Development only: the Marketplace installs the plugin for ordinary users.
.PHONY: install-backend-local install-plugin
install-backend-local: backend
	python3 scripts/backend-runtime.py install-local

install: install-backend-local
	bash scripts/link-plugin.sh

# Reset the private runtime so the setup page exercises a fresh installation.
install-plugin:
	python3 scripts/backend-runtime.py uninstall
	bash scripts/link-plugin.sh
