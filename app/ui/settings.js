// @ts-check

// Where mailboxes are managed, and where every setting that has nowhere else
// to live now lives.
//
// The QML plugin split this in two: the panel's own page held reading, writing
// and the mailboxes, while the shell's plugin dialog held the eight settings
// `manifest.json` declares. A standalone window has no shell dialog, so both
// halves are here — in the order the QML page read them, with the shell's own
// rows folded into the sections they belong to.

import { div } from "gpui";
import { Button as BaseButton, h_flex, v_flex } from "gpui-base";
import {
  Button,
  CenteredWorkspace,
  Label,
  MutedText,
  PageColumn,
  Separator,
  Surface,
  TextField,
  Title,
  alpha,
  role,
  style,
} from "omarchy-ui";
import { iconTextButton } from "./controls.js";
import { slotColor } from "./calendar-palette.js";
import {
  choiceField,
  kebab,
  numberField,
  preferenceRow,
  settingsSection,
  textField,
  toggleSwitch,
} from "./settings-preferences.js";

// The page in the order the QML settings page read it: what a message does,
// what a draft does, what the bar does while the window is closed, then the
// mailboxes themselves, the calendars they serve, and the one Google client
// every one of them signs in through.
const PAGE = [
  "Reading",
  "Writing",
  "In the bar",
  "Mailboxes",
  "Calendars",
  "Google OAuth client",
];

/**
 * The secondary tone `App.qml` handed this page as `dimColor`. gpui's token
 * set has no room for it, so it lives beside the theme; where no Omarchy
 * palette has been read the muted foreground carries the same meaning.
 * @param {import("gpui").Context} cx
 */
const dim = (cx) => role("dim", cx.theme().colors.muted_foreground);

/**
 * One handler, or the three the host still passes by name.
 *
 * `onPreference(key, value, cx)` is what this page wants; until the host hands
 * one down, the three settings it does wire up are bridged here rather than
 * left dead. A setting with neither is drawn disabled by `writable` below,
 * because a control that fails after it is pressed is worse than one that
 * never offered.
 * @param {any} model @param {any} entry
 */
function handlerFor(model, entry) {
  if (typeof model.onPreference === "function")
    return (/** @type {unknown} */ value, /** @type {any} */ cx) =>
      model.onPreference(entry.key, value, cx);
  /** @type {Record<string, string>} */
  const named = {
    remoteImages: "onRemoteImages",
    heavyMessageRendering: "onHeavyMessages",
    undoSendSeconds: "onUndoSend",
  };
  const handler = model[named[entry.key]];
  return typeof handler === "function"
    ? (/** @type {unknown} */ value, /** @type {any} */ cx) =>
        handler(value, cx)
    : null;
}

/** @param {any} model @param {any} entry @param {import("gpui").Context} cx */
function preferenceControl(model, entry, cx) {
  const change = handlerFor(model, entry);
  const disabled = entry.disabled === true || model.busy === true || !change;
  const id = `settings-${kebab(entry.key)}`;
  if (entry.kind === "toggle")
    return toggleSwitch(
      `${id}-toggle`,
      entry.value === true,
      entry.label,
      (_event, eventCx) => change?.(entry.value !== true, eventCx),
      cx,
      { disabled },
    );
  if (entry.kind === "number")
    return numberField(
      `${id}-number`,
      {
        value: Number(entry.value),
        min: Number(entry.min),
        max: Number(entry.max),
        step: Number(entry.step),
        label: entry.label,
        unit: entry.unit,
        disabled,
      },
      (direction, eventCx) => {
        // Stepping is the controller's arithmetic, not the view's: it owns the
        // bounds and knows what to do with a value that is off the step grid.
        if (typeof model.onStepPreference === "function")
          model.onStepPreference(entry.key, direction, eventCx);
        else
          change?.(
            Math.max(
              Number(entry.min),
              Math.min(
                Number(entry.max),
                Number(entry.value) + direction * Number(entry.step || 1),
              ),
            ),
            eventCx,
          );
      },
      cx,
    );
  if (entry.kind === "choice")
    return choiceField(
      `${id}-choice`,
      {
        options: Array.isArray(entry.options) ? entry.options : [],
        value: String(entry.value),
        label: entry.label,
        disabled,
      },
      (option, eventCx) => change?.(option, eventCx),
      cx,
    );
  return textField(
    `${id}-text`,
    {
      value: String(entry.value ?? ""),
      label: entry.label,
      state: model.fields?.[entry.key],
      disabled,
    },
    cx,
  );
}

/** @param {any} model @param {string} section @param {import("gpui").Context} cx */
function preferenceRows(model, section, cx) {
  const preferences = Array.isArray(model.preferences) ? model.preferences : [];
  return preferences
    .filter((/** @type {any} */ entry) => entry.section === section)
    .map((/** @type {any} */ entry) =>
      preferenceRow(
        `settings-${kebab(entry.key)}`,
        entry,
        preferenceControl(model, entry, cx),
        cx,
      ),
    );
}

/** @param {any} model @param {import("gpui").Context} cx */
function accountRows(model, cx) {
  const tokens = style();
  const confirming = Boolean(model.pendingRemoval);
  const foreground = cx.theme().colors.foreground;
  return (model.accounts || []).map((/** @type {any} */ account) => {
    const active = account.active ?? account.status === "Active";
    return h_flex()
      .id(`settings-account-${account.id}`)
      .role("list_item")
      .items_center()
      .justify_between()
      .w_full()
      .min_w_0()
      .gap(tokens.spacing.xl)
      .px(tokens.spacing.rowPaddingX)
      .py(tokens.spacing.lg)
      .rounded(tokens.cornerRadius)
      .bg(
        alpha(
          foreground,
          active
            ? tokens.state.selectedFillAlpha
            : tokens.state.normalFillAlpha,
        ),
      )
      .when(confirming, (row) => row.opacity(0.4))
      .child(
        v_flex()
          .flex_1()
          .min_w_0()
          .gap(tokens.spacing.xxs)
          .child(
            // The address itself, never rendered as anything but text: it is a
            // value the user typed and a stranger may have chosen.
            new Label(account.email || account.label || "New mailbox")
              .build(cx)
              .text_size(tokens.font.bodySmall)
              .truncate()
              .when(active, (line) => line.font_bold()),
          )
          .child(
            new MutedText(`${account.providerName} · ${account.detail || ""}`)
              .build(cx)
              .text_size(tokens.font.caption)
              .truncate()
              .when(Boolean(account.failed), (line) =>
                line.text_color(cx.theme().colors.destructive),
              ),
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .items_center()
          .gap(tokens.spacing.md)
          // Every one of these is an `IconTextButton` in the QML, which stands
          // at the theme's control height whatever it says.
          .when(!active, (actions) =>
            actions.child(
              iconTextButton(`settings-switch-${account.id}`, "", "Switch")
                .disabled(model.busy === true || confirming)
                .onClick((_event, eventCx) =>
                  model.onSwitch?.(account.id, eventCx),
                )
                .build(cx),
            ),
          )
          .when(typeof model.onEdit === "function", (actions) =>
            actions.child(
              iconTextButton(`settings-edit-${account.id}`, "", "Edit…")
                .tooltip("Edit this mailbox")
                .disabled(model.busy === true || confirming)
                .onClick((_event, eventCx) => model.onEdit(account.id, eventCx))
                .build(cx),
            ),
          )
          .child(
            iconTextButton(`settings-remove-${account.id}`, "", "Remove…")
              .danger()
              .bordered(false)
              .disabled(model.busy === true || confirming)
              .onClick((_event, eventCx) =>
                model.onRemove?.(account.id, eventCx),
              )
              .build(cx),
          ),
      );
  });
}

/**
 * The seven slots of the desktop palette a calendar can be drawn in.
 *
 * Swatches rather than the named buttons `choiceField` draws, because the
 * thing being chosen is a colour and its name says less than it does. The
 * selection is never the colour alone: the chosen slot is ringed at the
 * theme's selected border alpha and twice its rule width, which is what a
 * theme that puts two slots close together still shows.
 * @param {any} model @param {any} source @param {import("gpui").Context} cx
 */
function calendarColorChoice(model, source, cx) {
  const tokens = style();
  const size = Math.max(
    tokens.space(12),
    Math.round(tokens.spacing.controlHeight * 0.4),
  );
  return h_flex()
    .id(`settings-calendar-color-${source.id}`)
    .role("radio_group")
    .accessibility_label(`Colour for ${source.name}`)
    .flex_none()
    .items_center()
    .gap(tokens.spacing.xxs)
    .children(
      (source.colorKeys ?? []).map((/** @type {string} */ key) => {
        const chosen = key === source.colorKey;
        return BaseButton.new(`settings-calendar-color-${source.id}-${key}`)
          .role("radio_button")
          .selected(chosen)
          .accessibility_label(key)
          .tooltip(key)
          .flex_none()
          .size(size)
          .rounded(tokens.cornerRadius)
          .bg(slotColor(model.calendarForm?.palette, key, cx))
          .border(
            chosen
              ? tokens.state.normalBorderWidth * 2
              : tokens.state.normalBorderWidth,
          )
          .border_color(
            alpha(
              cx.theme().colors.foreground,
              chosen
                ? tokens.state.selectedBorderAlpha
                : tokens.state.normalBorderAlpha,
            ),
          )
          .on_click((_event, eventCx) =>
            model.onCalendarColor(source.id, key, eventCx),
          );
      }),
    );
}

/**
 * The password row a calendar opens under itself. The field is masked and its
 * value never leaves this page except as the one host request that puts it in
 * the keyring.
 * @param {any} model @param {any} source @param {import("gpui").Context} cx
 */
function calendarPasswordRow(model, source, cx) {
  const tokens = style();
  const form = model.calendarForm ?? {};
  return h_flex()
    .id(`settings-calendar-password-row-${source.id}`)
    .items_center()
    .w_full()
    .min_w_0()
    .gap(tokens.space(6))
    .child(
      new TextField()
        .state(form.fields.existingPassword)
        .build(cx)
        .id(`settings-calendar-password-field-${source.id}`)
        .accessibility_label(`Password for ${source.name}`)
        .flex_1()
        .min_w_0(),
    )
    .child(
      iconTextButton(`settings-calendar-password-save-${source.id}`, "", "Save")
        .disabled(form.busy === true)
        .onClick((_event, eventCx) =>
          model.onCalendarPasswordSave(source.id, eventCx),
        )
        .build(cx),
    )
    .child(
      // Borderless and dim: leaving the field is not the thing this row is for.
      new Button(`settings-calendar-password-cancel-${source.id}`)
        .label("Cancel")
        .tone(dim(cx))
        .size("small")
        .onClick((_event, eventCx) =>
          model.onCalendarPassword(source.id, eventCx),
        )
        .build(cx)
        .h(tokens.spacing.controlHeight),
    );
}

/** @param {any} model @param {import("gpui").Context} cx */
function calendarRows(model, cx) {
  const tokens = style();
  const sources = model.calendars?.sources ?? [];
  const form = model.calendarForm;
  if (sources.length === 0)
    return [
      new MutedText("No calendars yet.")
        .build(cx)
        .text_size(tokens.font.caption),
    ];
  return sources.map((/** @type {any} */ source) =>
    v_flex()
      .id(`settings-calendar-${source.id}`)
      .role("list_item")
      .w_full()
      .min_w_0()
      .gap(tokens.spacing.md)
      .child(
        h_flex()
          .items_center()
          .justify_between()
          .w_full()
          .min_w_0()
          .gap(tokens.spacing.lg)
          .child(
            v_flex()
              .flex_1()
              .min_w_0()
              .gap(tokens.spacing.xxs)
              .child(
                new Label(source.name)
                  .build(cx)
                  .text_size(tokens.font.bodySmall)
                  .truncate(),
              )
              .child(
                new MutedText(
                  source.kind === "google"
                    ? "Google Calendar"
                    : source.url || "CalDAV",
                )
                  .build(cx)
                  .text_size(tokens.font.caption)
                  .truncate(),
              ),
          )
          .child(
            h_flex()
              .flex_none()
              .items_center()
              .gap(tokens.spacing.sm)
              // Every control here needs a host to answer it, and one that has
              // not been wired up yet is not drawn at all: a button that fails
              // after it is pressed is worse than one that never offered.
              .when(typeof model.onCalendarColor === "function", (actions) =>
                actions.child(calendarColorChoice(model, source, cx)),
              )
              // A Google calendar comes and goes with the mailbox that serves
              // it, so it has no remove and no password of its own.
              .when(
                source.removable &&
                  typeof model.onCalendarPassword === "function",
                (actions) =>
                  actions.child(
                    // Borderless, the way `CalendarSettings.qml` draws both of
                    // these: the row is a calendar, not a control panel. No
                    // ellipsis either — the field it opens lands under this
                    // row rather than in a dialog or a page.
                    iconTextButton(
                      `settings-calendar-password-${source.id}`,
                      "",
                      "Set password",
                    )
                      .bordered(false)
                      .onClick((_event, eventCx) =>
                        model.onCalendarPassword(source.id, eventCx),
                      )
                      .build(cx),
                  ),
              )
              .when(
                source.removable &&
                  typeof model.onCalendarRemove === "function",
                (actions) =>
                  actions.child(
                    iconTextButton(
                      `settings-calendar-remove-${source.id}`,
                      "",
                      "Remove",
                    )
                      .danger()
                      .bordered(false)
                      .onClick((_event, eventCx) =>
                        model.onCalendarRemove(source.id, eventCx),
                      )
                      .build(cx),
                  ),
              )
              // Switching a calendar off leaves it configured and stops it
              // being read, which is why it is a switch and not the Remove
              // button beside it.
              .when(typeof model.onCalendarEnabled === "function", (actions) =>
                actions.child(
                  toggleSwitch(
                    `settings-calendar-enabled-${source.id}`,
                    source.enabled !== false,
                    `Show ${source.name}`,
                    (_event, eventCx) =>
                      model.onCalendarEnabled(
                        source.id,
                        source.enabled === false,
                        eventCx,
                      ),
                    cx,
                    { disabled: model.calendarForm?.busy === true },
                  ),
                ),
              ),
          ),
      )
      .when(
        Boolean(form?.fields?.existingPassword) &&
          form.passwordEditingId === source.id &&
          typeof model.onCalendarPasswordSave === "function",
        (row) => row.child(calendarPasswordRow(model, source, cx)),
      ),
  );
}

/**
 * Adding a CalDAV calendar: the four things `CalendarSettings.qml` asks for,
 * and the password among them going nowhere but the keyring.
 * @param {any} model @param {import("gpui").Context} cx
 */
function calendarAddForm(model, cx) {
  const tokens = style();
  const form = model.calendarForm;
  if (!form?.adding || typeof model.onCalendarAddSave !== "function")
    return null;
  /** @param {string} name @param {string} caption */
  const row = (name, caption) =>
    new TextField()
      .state(form.fields[name])
      .build(cx)
      .id(`settings-calendar-new-${name}`)
      .accessibility_label(caption)
      .w_full();
  return v_flex()
    .id("settings-calendar-new")
    .role("group")
    .accessibility_label("Add a calendar")
    .w_full()
    .min_w_0()
    .gap(tokens.space(6))
    .child(row("name", "Calendar name"))
    .child(row("url", "CalDAV URL"))
    .child(row("username", "Username"))
    .child(row("password", "Password or app password"))
    .child(
      h_flex()
        .flex_none()
        .items_center()
        .gap(tokens.space(6))
        .child(
          iconTextButton(
            "settings-calendar-save",
            "",
            form.busy ? "Adding" : "Add calendar",
          )
            .disabled(form.busy)
            .onClick((_event, eventCx) => model.onCalendarAddSave(eventCx))
            .build(cx),
        )
        .child(
          new Button("settings-calendar-cancel")
            .label("Cancel")
            .tone(dim(cx))
            .size("small")
            .onClick((_event, eventCx) => model.onCalendarAddCancel(eventCx))
            .build(cx)
            .h(tokens.spacing.controlHeight),
        ),
    );
}

/**
 * What the last calendar write said. A refusal names the reason; a success
 * says so once, because the row it changed is already on screen changed.
 * @param {any} model @param {import("gpui").Context} cx
 */
function calendarResult(model, cx) {
  const tokens = style();
  const result = String(model.calendarForm?.result || "");
  if (result === "") return null;
  return div()
    .id("settings-calendar-result")
    .w_full()
    .text_size(tokens.font.caption)
    .text_color(
      model.calendarForm?.saved
        ? cx.theme().colors.muted_foreground
        : cx.theme().colors.destructive,
    )
    .child(result);
}

/** @param {any} model @param {import("gpui").Context} cx */
function oauthClientRow(model, cx) {
  const tokens = style();
  const client = model.oauthClient ?? {};
  return h_flex()
    .id("settings-oauth-client")
    .items_center()
    .justify_between()
    .w_full()
    .min_w_0()
    .gap(tokens.spacing.xl)
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .gap(tokens.spacing.xxs)
        .child(
          new Label(
            client.present
              ? client.description || "Google OAuth client"
              : "No client yet",
          )
            .build(cx)
            .text_size(tokens.font.bodySmall)
            .truncate(),
        )
        .child(
          new MutedText(client.detail || "Shared by every mailbox above")
            .build(cx)
            .text_size(tokens.font.caption),
        ),
    )
    .when(typeof model.onClientSetup === "function", (row) =>
      row.child(
        // Outlined and dim: the client is shared by every mailbox, so changing
        // it is a rarer thing than anything else on this page.
        iconTextButton(
          "settings-oauth-client-setup",
          "",
          client.present ? "Change…" : "Set up…",
        )
          .tone(dim(cx))
          .onClick((_event, eventCx) => model.onClientSetup(eventCx))
          .build(cx),
      ),
    );
}

/**
 * `AccountRemovalDialog.qml`: a modal over the page rather than a panel
 * appended to it, because the question has to be answered before anything else
 * on the page means what it says. The rows underneath dim rather than vanish,
 * so the mailbox being removed is still readable behind it.
 * @param {any} model @param {import("gpui").Context} cx
 */
function removalDialog(model, cx) {
  const tokens = style();
  const pending = model.pendingRemoval;
  return div()
    .id("settings-remove-scrim")
    .absolute()
    .inset_0()
    .flex()
    .items_center()
    .justify_center()
    .p(tokens.spacing.panelPadding)
    .bg(alpha(cx.theme().colors.background, 0.85))
    .child(
      new Surface()
        .build(cx)
        .id("settings-remove-confirmation")
        .role("alert_dialog")
        .accessibility_label(pending.title)
        .w_full()
        .max_w(tokens.space(360))
        .gap(tokens.spacing.xxxl)
        .p(tokens.spacing.huge)
        .child(
          new Title(pending.title)
            .build(cx)
            .text_size(tokens.font.heading)
            .font_bold(),
        )
        .child(
          new MutedText(pending.detail)
            .build(cx)
            .text_size(tokens.font.bodySmall),
        )
        .child(
          h_flex()
            .justify_end()
            .gap(tokens.spacing.controlGap)
            .child(
              new Button("settings-remove-cancel")
                .label("Cancel")
                .disabled(model.busy === true)
                .onClick((_event, eventCx) =>
                  model.onCancelRemove?.(_event, eventCx),
                )
                .build(cx),
            )
            .child(
              new Button("settings-remove-confirm")
                .label(model.busy ? "Removing…" : "Remove")
                .danger()
                .disabled(model.busy === true)
                .onClick((_event, eventCx) =>
                  model.onConfirmRemove?.(_event, eventCx),
                )
                .build(cx),
            ),
        ),
    );
}

/** @param {any} model @param {import("gpui").Context} cx */
export function renderSettings(model, cx) {
  const tokens = style();
  const preferences = Array.isArray(model.preferences) ? model.preferences : [];
  const confirming = Boolean(model.pendingRemoval);
  // Anything the table introduced under a section this page does not name is
  // still drawn, at the end: a setting that silently disappeared would be
  // worse than one in the wrong place.
  const sections = PAGE.concat(
    preferences
      .map((/** @type {any} */ entry) => entry.section)
      .filter(
        (
          /** @type {string} */ section,
          /** @type {number} */ index,
          /** @type {string[]} */ all,
        ) => !PAGE.includes(section) && all.indexOf(section) === index,
      ),
  );

  const column = new PageColumn("settings-column")
    .maxWidth(tokens.space(560) + tokens.spacing.panelPadding * 2)
    .build(cx)
    // Everything on this page is `space(16)` from its neighbour, captions
    // included: the QML page is one column and that is its spacing.
    .gap(tokens.space(16))
    // The page carries its own way out, above its heading. The window header
    // above it says what this window is, not where in it you are.
    .when(typeof model.onBack === "function", (page) =>
      page.child(
        h_flex().child(
          // `BackBar.qml`: the drawn arrow rather than a typed one, outlined,
          // and quieter than the page it leaves.
          iconTextButton("settings-back", "back", "Back")
            .tooltip("Back · Esc")
            .tone(dim(cx))
            .onClick((event, eventCx) => model.onBack(event, eventCx))
            .build(cx),
        ),
      ),
    )
    .child(
      new Title("Settings")
        .build(cx)
        .text_size(tokens.font.heading)
        .font_bold(),
    );

  for (const section of sections) {
    const rows = preferenceRows(model, section, cx);
    if (section === "Mailboxes")
      column
        .child(
          settingsSection(
            "settings-accounts-group",
            "Mailboxes",
            [
              // The mailboxes are a list, not a run of separate settings: the
              // QML stacks them in a column of their own at `space(2)`, so the
              // rows read as one block and the button under them does not.
              v_flex()
                .id("settings-accounts")
                .role("list")
                .w_full()
                .min_w_0()
                .gap(tokens.space(2))
                .children(accountRows(model, cx)),
            ],
            cx,
          ).child(
            // Wrapped, because a column stretches its children across it and
            // this button is as wide as its label — the QML lays it out by its
            // implicit width.
            h_flex().child(
              iconTextButton("settings-add-account", "plus", "Add a mailbox…")
                .tooltip("Add another mail account")
                .disabled(model.busy === true || confirming)
                .onClick((_event, eventCx) => model.onAdd?.(_event, eventCx))
                .build(cx),
            ),
          ),
        )
        .child(new Separator().build(cx));
    else if (section === "Calendars")
      column
        .child(
          settingsSection(
            "settings-calendars-group",
            "Calendars",
            [
              new MutedText(model.calendars?.detail || "")
                .build(cx)
                .text_size(tokens.font.caption),
              ...calendarRows(model, cx),
              calendarAddForm(model, cx),
              typeof model.onCalendarAdd === "function" &&
              model.calendarForm?.adding !== true
                ? h_flex().child(
                    iconTextButton(
                      "settings-add-calendar",
                      "plus",
                      "Add a calendar",
                    )
                      .onClick((_event, eventCx) =>
                        model.onCalendarAdd(eventCx),
                      )
                      .build(cx),
                  )
                : null,
              calendarResult(model, cx),
            ],
            cx,
            // `CalendarSettings.qml` is a column of its own inside the page,
            // and it is tighter than the page around it.
            { gap: tokens.space(8) },
          ),
        )
        .child(new Separator().build(cx));
    else if (section === "Google OAuth client")
      column.child(
        settingsSection(
          "settings-oauth-group",
          "Google OAuth client",
          [oauthClientRow(model, cx), ...rows],
          cx,
        ),
      );
    else if (rows.length)
      column.child(
        settingsSection(
          `settings-${kebab(section.replace(/\s+/g, "-"))}-group`,
          section,
          rows,
          cx,
        ),
      );
  }

  if (model.error)
    column.child(
      div()
        .id("settings-error")
        .role("alert")
        .text_size(tokens.font.caption)
        .text_color(cx.theme().colors.destructive)
        .child(model.error),
    );

  return v_flex()
    .id("settings-page")
    .role("region")
    .accessibility_label("Settings")
    .relative()
    .size_full()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.background)
    .child(
      new CenteredWorkspace("settings-workspace").content(column).build(cx),
    )
    .when(confirming, (page) => page.child(removalDialog(model, cx)));
}
