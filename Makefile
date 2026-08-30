QMLLINT := /usr/lib/qt6/bin/qmllint
QML_FILES := Service.qml BarWidget.qml App.qml \
	account/MailAccount.qml \
	cache/CacheStore.qml cache/BodyCache.qml \
	providers/AuthManager.qml providers/GmailApiClient.qml \
	providers/ImapAuth.qml providers/ImapClient.qml \
	providers/HeyAuth.qml providers/HeyClient.qml \
	components/ImapSetupPage.qml \
	components/HeySetupPage.qml \
	components/ProviderPicker.qml \
	components/GmailIcon.qml \
	components/ProviderLogo.qml \
	components/ProviderHero.qml \
	components/LinkLabel.qml \
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
	components/AttachmentRow.qml \
  components/KeyHints.qml \
	components/MessageReader.qml \
	components/ReaderNotice.qml \
	components/InviteCard.qml \
	components/ReaderBlankSlate.qml \
	components/ReaderSkeleton.qml \
	components/ComposeView.qml \
	components/RecipientSuggestions.qml \
	components/UndoSendToast.qml \
	components/DraftSavedToast.qml \
	components/SearchBar.qml \
	components/AppMenu.qml \
	components/AccountSwitcher.qml \
	components/AccountRemovalDialog.qml \
	components/BackBar.qml \
	components/UserBar.qml \
	components/SettingsPage.qml \
	components/CalendarSettings.qml \
	components/CalendarEventComposer.qml \
	components/CalendarEventDetail.qml \
	components/CalendarPalette.qml \
	components/ConfirmDeleteDialog.qml \
	components/SetupPage.qml \
	components/ShortcutHelp.qml \
	calendar/CalendarController.qml calendar/CalendarCache.qml \
	components/CalendarView.qml \
	components/WeekCalendarView.qml \
	bar/BarPreview.qml

.PHONY: test test-js test-app test-shell test-qml qml-check validate bench

test: test-js test-app test-shell test-qml

# The parsing, formatting, and decision rules live in plain JS precisely so
# they can be tested without a compositor. These run anywhere node does.
test-js:
	node tests/test_bar_status.js
	node tests/test_outbox.js
	node tests/test_recipients.js
	node tests/test_senders.js
	node tests/test_oauth.js
	node tests/test_credentials.js
	node tests/test_gmail_api.js
	node tests/test_message.js
	node tests/test_calendar.js
	node tests/test_calendar_cache.js
	node tests/test_calendar_feed.js
	node tests/test_calendar_sources.js
	node tests/test_calendar_palette.js
	node tests/test_bar_preview.js
	node tests/test_unsubscribe.js
	node tests/test_mailto.js
	node tests/test_html.js
	node tests/test_cache.js
	node tests/test_model.js
	node tests/test_keymap.js
	node tests/test_accounts.js
	node tests/test_menu.js
	node tests/test_provider.js
	node tests/test_imap.js
	node tests/test_hey.js

test-app:
	node tests/test_omarchy_ui.mjs
	node tests/test_omarchy_ui_style.mjs
	node tests/test_account_store.mjs
	node tests/test_app_keymap.mjs
	node tests/test_app_actions.mjs
	node tests/test_app_state.mjs
	node tests/test_imap_autofill.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_app_integration.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_app_compose_attachments.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_app_compose_flows.mjs
	node tests/test_application_controller.mjs
	node tests/test_app_adapters_effect_port.mjs
	node tests/test_app_adapters_factory.mjs
	node tests/test_app_adapters_gmail.mjs
	node tests/test_app_adapters_hey.mjs
	node tests/test_app_adapters_imap.mjs
	node tests/test_setup_adapters.mjs
	node tests/test_setup_controller.mjs
	node tests/test_settings_controller.mjs
	node tests/test_mail_state.mjs
	node tests/test_mail_clock.mjs
	node tests/test_app_commands.mjs
	node tests/test_compose_controller.mjs
	node tests/test_calendar_controller.mjs
	node tests/test_qml_js_to_esm.mjs
	node tests/test_generated_app_modules.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_omarchy_ui_render.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_app_render.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_mail_ui_layout.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_mail_ui_composition.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_mail_ui_chrome.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_mail_ui_list.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_mail_actions.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_mail_ui_reader_states.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_mail_ui_reader_security.mjs
	node tests/test_reader_controller.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_reader_selection.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_compose_ui_render.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_calendar_ui_render.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_calendar_ui_chrome.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_setup_ui_render.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_settings_ui_render.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_calendar_sources_wiring.mjs
	node --no-warnings --experimental-loader ./tests/gpui_loader.mjs tests/test_icons.mjs
	BUN_TMPDIR=/tmp/omamail-bun BUN_INSTALL=/tmp/omamail-bun/install bunx tsc -p app/jsconfig.json
	cargo test

test-shell:
	python3 tests/test_contacts.py
	python3 tests/test_qml_names.py
	python3 tests/test_qml_text_format.py
	bash tests/test_source.sh
	bash tests/test_service_source.sh
	bash tests/test_install.sh
	bash tests/test_mailto.sh
	bash tests/test_transport.sh
	bash tests/test_unsubscribe_transport.sh
	bash tests/test_image_fetch.sh
	bash tests/test_attachment_open.sh
	bash tests/test_attachment.sh
	bash tests/test_calendar_transport.sh
	bash tests/test_calendar_write.sh
	bash tests/test_calendar_delete.sh
	bash tests/test_release_notes.sh

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
	QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software \
		$(QMLTESTRUNNER) -import $(CURDIR)/tests/qml/imports -input tests/qml

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
