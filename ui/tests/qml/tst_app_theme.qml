import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import qs.Commons as Commons
import "../../theme"
import "../../kit" as Kit
import "../../components" as Components
import "../../bar" as Bar
import "../../calendar/Palette.js" as CalendarPalette

// The window's own theme.
//
// The defect this test exists for is invisible in a stub that honours the
// colours it is handed: the real shell renders shell.toml with the desktop
// theme's hex baked into `[controls]`, so Style's helpers ignore their
// arguments and answer with the desktop's foreground. A window drawn in a light
// theme on a dark desktop then paints near-white text on a near-white surface.
//
// So the stub Style is told to behave the way the shell does, the desktop is a
// distinctly neutral palette (white on black), and the picked theme is a light
// one whose foreground is blue-grey. Every colour in it is therefore
// distinguishable from every colour blended out of the desktop's: the theme's
// are not neutral, the desktop's are.
Item {
  id: scene
  width: 720
  height: 1200

  readonly property string lightTheme: [
    'mode = "light"',
    'foreground = "#4c4f69"',
    'background = "#eff1f5"',
    'accent = "#8839ef"',
    'red = "#d20f39"',
    'muted = "#8c8fa1"',
    'selection = "#ccd0da"',
  ].join("\n")

  readonly property string darkTheme: [
    'mode = "dark"',
    'foreground = "#cdd6f4"',
    'background = "#1e1e2e"',
    'accent = "#89b4fa"',
    'red = "#f38ba8"',
    'muted = "#6c7086"',
    'selection = "#45475a"',
  ].join("\n")

  Component.onCompleted: {
    // The real shell behaves this way by construction — its shell.toml has the
    // desktop theme's hex baked in — so the stub is told to. Running this file
    // against the real shell instead (a supplied theme state and
    // `-import /usr/share/omarchy/shell`) needs neither switch.
    if (Style.bakedStateColors !== undefined) {
      Style.bakedStateColors = true
      Style.bakedForeground = Commons.Color.foreground
    }
  }

  // Paint reads a theme through FileView. The test supplies the file's text and
  // runs the same parse → resolve → rebuild path the window runs when it opens
  // a theme, so everything below the file read is production code.
  function pickTheme(name) {
    Paint.available = true
    Paint.themeName = name
    Paint.themeDir = "/themes/" + name
    Paint.colorsText = name === "fixture-dark" ? scene.darkTheme : scene.lightTheme
    Paint.shellText = ""
    Paint.rebuild()
  }

  // The stored setting, and the one path a picker's change takes: the window
  // stores it, then draws with it.
  property string persistedTheme: ""
  function changeTheme(next) {
    scene.persistedTheme = next
    // The window stores the choice and the picker reads it back, which is what
    // the settings service does around this row.
    themePicker.value = next
    if (next === "") scene.followOmarchy()
    else scene.pickTheme(next)
  }

  // The first item below `item` whose text is `label`, so a test can read the
  // weight or colour of the label a person actually sees.
  function textItemFor(item, label) {
    if (item.text !== undefined && String(item.text) === label && item.font !== undefined
        && item.visible !== false) return item
    var kids = item.children || []
    for (var i = 0; i < kids.length; i++) {
      var found = scene.textItemFor(kids[i], label)
      if (found !== null) return found
    }
    return null
  }

  // The first object below `item` that publishes a tooltip with `label`.
  function tooltipItemFor(item, label) {
    if (item.contentItem !== undefined && item.text !== undefined
        && String(item.text) === label) return item
    var kids = item.children || []
    for (var i = 0; i < kids.length; i++) {
      var found = scene.tooltipItemFor(kids[i], label)
      if (found !== null) return found
    }
    return null
  }

  function followOmarchy() {
    Paint.available = true
    Paint.themeName = ""
    Paint.themeDir = ""
    Paint.colorsText = ""
    Paint.shellText = ""
    Paint.rebuild()
  }

  // Every colour a visible item paints — its own fill and its border's — with
  // the item it came from, so a failure names the thing that painted it. A
  // subtree at zero opacity is the base control a wrapper hides while it draws
  // its own copy.
  function paintedColours(item, found, trail) {
    if (!item) return found
    if (item.visible === false || item.opacity <= 0.01) return found
    var where = (trail === undefined ? "" : trail) + "/"
      + (item.objectName !== "" && item.objectName !== undefined ? item.objectName : String(item))
    if (item.color !== undefined && item.color !== null && typeof item.color === "object") {
      found.push({ where: where, colour: item.color })
    }
    // A Rectangle's pen defaults to an opaque black at width 1 whether or not
    // anything asked for a border, and Qt draws nothing while that pen is
    // unset. An unset pen is therefore exactly this colour, and the theme's are
    // never opaque black.
    if (item.border && item.border.width > 0 && typeof item.border.color === "object"
        && String(item.border.color) !== "#000000") {
      found.push({ where: where + ".border", colour: item.border.color })
    }
    var kids = item.children || []
    for (var i = 0; i < kids.length; i++) paintedColours(kids[i], found, where)
    return found
  }

  // White and black are both neutral, so every alpha variant and every
  // darkening of the desktop's foreground or background is neutral too. The
  // picked theme states none: its roles are tinted greys, a purple accent and a
  // red urgent colour.
  function isDesktopNeutral(colour) {
    if (colour.a <= 0.02) return false
    return Math.abs(colour.r - colour.g) < 0.01 && Math.abs(colour.g - colour.b) < 0.01
  }

  function neutralColours(item) {
    var found = paintedColours(item, [])
    var out = []
    for (var i = 0; i < found.length; i++) {
      if (isDesktopNeutral(found[i].colour)) out.push(found[i].where + " " + String(found[i].colour))
    }
    return out
  }

  function paintColour(list, wanted) {
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].colour) === String(wanted)) return true
    }
    return false
  }

  // One window's worth of surfaces: App's semantic colours as a composed
  // panel, and every kit control Omamail uses, through the wrappers.
  Column {
    id: surface
    x: 8
    y: 8
    width: parent.width - 16
    spacing: 6

    Rectangle {
      objectName: "window-surface"
      width: surface.width
      height: 24
      color: Paint.background

      Text {
        objectName: "window-heading"
        text: "Inbox"
        color: Paint.foreground
        font.family: Style.font.family
      }
    }

    Rectangle {
      id: card
      objectName: "card"
      width: surface.width
      height: 28
      radius: Style.cornerRadius
      color: Paint.normalFillFor(Paint.foreground, Paint.accent)
      border.width: Paint.normalBorderWidth
      border.color: Paint.normalBorderFor(Paint.foreground, Paint.accent)

      Text {
        text: "A card"
        color: Paint.foreground
        font.family: Style.font.family
      }
    }

    Kit.Button {
      objectName: "kit-button"
      text: "Archive"
      chosen: true
      foreground: Paint.foreground
      accent: Paint.accent
    }

    Kit.TextField {
      objectName: "kit-field"
      width: surface.width
      text: "hello"
      foreground: Paint.foreground
      accent: Paint.accent
    }

    Kit.ToggleSwitch {
      objectName: "kit-toggle"
      checked: true
      foreground: Paint.foreground
      accent: Paint.accent
    }

    Kit.Dropdown {
      objectName: "kit-dropdown"
      width: surface.width
      value: "one"
      options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }]
      foreground: Paint.popupText
      background: Paint.popupBackground
      popupBorder: Paint.popupBorder
      accent: Paint.accent
      fontFamily: Style.font.family
    }

    Components.IconButton {
      objectName: "icon-button"
      iconName: "archive"
      tooltipText: "Archive"
    }

    Components.IconTextButton {
      objectName: "icon-text-button"
      iconName: "check"
      text: "Save"
    }

    Components.ReaderNotice {
      objectName: "reader-notice"
      textColor: Paint.foreground
      dimColor: Paint.muted
      accentColor: Paint.accent
      panelFontFamily: Style.font.family
      text: "Remote images are blocked."
    }
  }

  Components.MessageRow {
    id: messageRow
    objectName: "message-row"
    x: 8
    y: surface.y + surface.height + 8
    width: parent.width - 16
    summary: ({
      id: "1", subject: "Quarterly report", from: "Ada <ada@example.org>",
      snippet: "The numbers are attached.", time: "09:12", unread: true,
      starred: false, subjectDirection: "", sourceLabel: ""
    })
    textColor: Paint.foreground
    accentColor: Paint.accent
    dimColor: Paint.muted
    panelFontFamily: Style.font.family
  }

  // The bar's own preview keeps the desktop's palette; the window beside it does
  // not. It is given the desktop's colours, as BarWidget gives it.
  Bar.BarPreview {
    id: barPreview
    objectName: "bar-preview"
    x: 8
    y: messageRow.y + messageRow.height + 8
    width: 300
    messages: []
    events: []
    textColor: Commons.Color.popups.text
    backgroundColor: Commons.Color.popups.background
    accentColor: Commons.Color.accent
    dimColor: Qt.rgba(Commons.Color.popups.text.r, Commons.Color.popups.text.g, Commons.Color.popups.text.b, 0.62)
    panelFontFamily: Style.font.family
  }

  // The NumberField is asserted through the one part of it the wrapper owns —
  // its spin box's background — because the rest of a spin box is platform
  // chrome in any host.
  Kit.NumberField {
    id: numberField
    objectName: "kit-number"
    x: 8
    y: barPreview.y + barPreview.height + 8
    label: "Snooze (minutes)"
    value: 5
    foreground: Paint.foreground
    accent: Paint.accent
  }

  // The window's own picker, and a bordered action with a tooltip: the two
  // surfaces whose colours and weight this feature is judged by.
  Kit.Dropdown {
    id: themePicker
    objectName: "theme-picker"
    x: 8; y: 780
    width: 320
    showLabel: false
    value: scene.persistedTheme
    options: [
      { value: "", label: "Follow Omarchy" },
      { value: "fixture-light", label: "Fixture Light" },
      { value: "fixture-dark", label: "Fixture Dark" }
    ]
    foreground: Paint.popupText
    background: Paint.popupBackground
    popupBorder: Paint.popupBorder
    accent: Paint.accent
    fontFamily: Style.font.family
    onChanged: function(next) { scene.changeTheme(next) }
  }

  Kit.Button {
    id: borderedButton
    objectName: "bordered-button"
    x: 8; y: 830
    width: 260; height: 40
    text: "Archive"
    tooltipText: "Move to archive"
    bordered: true
    foreground: Paint.foreground
    accent: Paint.accent
  }

  // The real mailbox row: a chosen tab is marked by its weight, not only by a
  // fill, so a theme must not take that away.
  Components.MailboxTabs {
    id: mailboxTabs
    objectName: "mailbox-tabs"
    x: 8; y: 890
    width: 500
    textColor: Paint.foreground
    accentColor: Paint.accent
    panelFontFamily: Style.font.family
    current: "inbox"
    allMailboxes: [
      { key: "inbox", label: "Inbox" },
      { key: "unread", label: "Unread" }
    ]
  }

  // The real calendar colour picker, with the controller shape it reads.
  QtObject {
    id: calendarController
    property var availableSources: ({ version: 1, sources: [
      { id: "one", kind: "google", name: "Work", colorKey: CalendarPalette.keys()[4], enabled: true }
    ] })
    property bool savingSource: false
    property bool discoveringCalendars: false
    property string discoveringAccountId: ""
    property var reminderPolicy: null
    property string defaultId: ""
    property int colorCalls: 0
    function setSourceColor(id, key) { calendarController.colorCalls += 1 }
    function setSourceEnabled(id, on) {}
    function removeCalendar(id) {}
    function setDefaultCalendar(id) {}
    function setRemindersEnabled(on) {}
    function setSnoozeMinutes(minutes) {}
    function addCalDavCalendar(source, password) {}
    function discoverCalendars(accountId, choice) {}
    function saveInvitations(on) {}
  }

  QtObject {
    id: calendarServiceStub
    property bool unifiedCalendarView: false
    property bool calendarRemindersEnabled: true
    property int calendarSnoozeMinutes: 5
    property string calendarReminderError: ""
    property var accountSummaries: []
    property var settings: ({})
    property var auth: null
    property bool backendCanDiscoverCalendars: true
    property bool backendCanGoogleCalendars: true
    property bool backendCanSaveInvitations: true
    property bool alwaysShowImages: false
    property bool alwaysRenderHeavyMessages: false
    property int undoSendSeconds: 10
    function persistSetting(name, value) { var next = {}; next[name] = value; calendarServiceStub.settings = next }
    function setUnifiedCalendarView(value) {}
  }

  Components.CalendarSettings {
    id: calendarSettings
    objectName: "calendar-settings"
    x: 8; y: 980
    width: 520
    service: calendarServiceStub
    controller: calendarController
    textColor: Paint.foreground
    dimColor: Paint.muted
    accentColor: Paint.accent
    urgentColor: Paint.urgent
    panelFontFamily: Style.font.family
  }

  // The real settings page around the real picker row.
  QtObject {
    id: settingsThemeStub
    property bool enabled: true
    property string selected: scene.persistedTheme
    property var options: [
      { value: "", label: "Follow Omarchy" },
      { value: "fixture-light", label: "Fixture Light" },
      { value: "fixture-dark", label: "Fixture Dark" }
    ]
    property int refreshes: 0
    function refresh() { settingsThemeStub.refreshes += 1 }
    function choose(name) { scene.changeTheme(name) }
  }

  QtObject {
    id: settingsServiceStub
    property var theme: settingsThemeStub
    property bool hasAppearance: false
    property string appearance: "system"
    property bool hasTray: true
    property bool hasMailto: true
    property bool hasNotifications: true
    property bool hasAgent: false
    property var accountSummaries: []
    property var accountSignatures: []
    property string activeAccountId: ""
    property var backend: null
    property var backendRuntime: null
    property var auth: null
    property bool backendCanNameSender: false
    property bool backendCanSuggestEvents: false
    property bool alwaysShowImages: false
    property bool alwaysRenderHeavyMessages: false
    property bool notifyNewMail: true
    property bool suggestEvents: false
    property bool showBarIcon: true
    property string contentDirection: "auto"
    property int undoSendSeconds: 10
    property string defaultMailClient: ""
    property bool defaultMailClientBusy: false
    property string defaultMailClientError: ""
    property string diagnoseError: ""
    property bool diagnosing: false
    property string notificationError: ""
    function persistSetting(name, value) {}
    function refreshDefaultMailClient() {}
    function setDefaultMailClient() {}
    function setAccountLabel() {}
    function setAccountSenderName() {}
    function setAccountSignature() {}
    function setAccountSignatureHtml() {}
    function setAppearance() {}
    function setContentDirection() {}
    function setAlwaysShowImages() {}
    function setAlwaysRenderHeavyMessages() {}
    function setNotifyNewMail() {}
    function setSuggestEvents() {}
    function setUndoSendSeconds() {}
    function setShowBarIcon() {}
    function chooseFiles() {}
  }

  // The two views a person spends the day in, and the two the review asked to
  // see drawn: the real message list and the real composer, with the smallest
  // services they will start against. Off screen, below the settings page,
  // where they cost the walk above nothing and still paint.
  QtObject {
    id: listServiceStub
    property var messages: [
      ({ id: "1:INBOX", threadId: "", from: { email: "ada@example.org", display: "Ada" },
        subject: "Quarterly report", snippet: "The numbers are attached.", time: "09:12",
        date: "", unread: true, starred: false, inInbox: true, labelIds: ["INBOX"] }),
      ({ id: "2:INBOX", threadId: "", from: { email: "bob@example.net", display: "Bob" },
        subject: "Lunch", snippet: "Thursday?", time: "08:40",
        date: "", unread: false, starred: false, inInbox: true, labelIds: ["INBOX"] })
    ]
    property bool hasMore: false
    property bool listLoading: false
    property bool listLoaded: true
    property string searchQuery: ""
    property string selectedId: ""
    property bool canArchive: true
    property string contentDirection: "auto"
    property var agentJobs: ({})
    property var agentAttentionByMessage: ({})
    function loadMore() {}
  }

  Components.MessageList {
    id: messageList
    objectName: "real-message-list"
    x: 1500; y: 1900
    width: 700
    height: 320
    service: listServiceStub
    textColor: Paint.foreground
    accentColor: Paint.accent
    dimColor: scene.dim
    urgentColor: Paint.urgent
    panelFontFamily: Style.font.family
  }

  QtObject {
    id: composeServiceStub
    property string activeAccountId: "ada@example.org"
    property string accountEmail: "ada@example.org"
    property var backend: null
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property var senderSources: []
    property var accountSignatures: [{ id: "ada@example.org", email: "ada@example.org", signature: "Ada" }]
    property var attachments: []
    property string selectedId: ""
    property string contentDirection: "auto"
    property bool alwaysShowImages: false
    property bool alwaysRenderHeavyMessages: false
    property int undoSendSeconds: 10
    function signatureFor(id) { return "Ada\nada.example.org" }
    function cachePath(kind) { return "/tmp/omamail-theme-test-" + kind }
    function refreshRecipientContacts() {}
    function loadAttachments(id, list, callback) { if (callback) callback([]) }
    function send(fields) { return true }
    function fail(result, message) {}
    function sendAgentProposal(id, fields) { return false }
    function accountEmailFor(id) { return String(id || "ada@example.org") }
  }

  // The composer is a DropArea, and a DropArea fills its parent whatever
  // geometry it is given: it is put in a frame of its own so it covers that
  // frame and not the whole scene.
  Item {
    id: composeFrame
    x: 1500; y: 2240
    width: 700
    height: 620

    Components.ComposeView {
      id: composeView
      objectName: "real-compose-view"
      anchors.fill: parent
      service: composeServiceStub
      opened: true
      textColor: Paint.foreground
      backgroundColor: Paint.background
      accentColor: Paint.accent
      dimColor: scene.dim
      dimmerColor: scene.dimmer
      popupBackgroundColor: Paint.popupBackground
      popupBorderColor: Paint.popupBorder
      panelFontFamily: Style.font.family
    }
  }

  // The sidebar's secondary text blends foreground toward background, as the
  // window does; the header and rows above use the same recipe.
  readonly property color dim: Qt.rgba(
    Paint.foreground.r * 0.68 + Paint.background.r * 0.32,
    Paint.foreground.g * 0.68 + Paint.background.g * 0.32,
    Paint.foreground.b * 0.68 + Paint.background.b * 0.32, 1)
  readonly property color dimmer: Qt.rgba(
    Paint.foreground.r * 0.45 + Paint.background.r * 0.55,
    Paint.foreground.g * 0.45 + Paint.background.g * 0.55,
    Paint.foreground.b * 0.45 + Paint.background.b * 0.55, 1)

  Components.SettingsPage {
    id: settingsPage
    objectName: "real-settings-page"
    x: 1500; y: 0
    width: 700
    height: 1800
    service: settingsServiceStub
    calendarController: calendarController
    textColor: Paint.foreground
    dimColor: Paint.muted
    accentColor: Paint.accent
    urgentColor: Paint.urgent
    panelFontFamily: Style.font.family
  }

  TestCase {
    name: "AppTheme"
    when: windowShown

    function init() {
      scene.followOmarchy()
    }

    // The core defect: a picked light theme on a dark desktop must not paint a
    // single desktop colour.
    function test_a_picked_theme_leaves_no_desktop_colour() {
      scene.pickTheme("fixture-light")
      verify(Paint.active, "the theme was read")
      verify(!Paint.following, "a theme is picked")

      var neutral = scene.neutralColours(surface)
      compare(neutral.length, 0, "the window paints only the theme's colours, not the desktop's: "
        + neutral.join(", "))
      var rowNeutral = scene.neutralColours(messageRow)
      compare(rowNeutral.length, 0, "a message row paints only the theme's colours: " + rowNeutral.join(", "))

      // And it is drawing with the picked palette, not with nothing at all.
      compare(String(Paint.foreground), "#4c4f69")
      compare(String(Paint.background), "#eff1f5")
      compare(String(Paint.accent), "#8839ef")
      // The kit's own helpers, which the shell's baked tokens broke, follow it.
      verify(!scene.isDesktopNeutral(Paint.hoverFillFor(Paint.foreground, Paint.accent)))
      verify(!scene.isDesktopNeutral(Paint.selectedStateColor(Paint.foreground, Paint.accent)))
      compare(String(Paint.selectedStateColor(Paint.foreground, Paint.accent)), "#4c4f69")
    }

    // Follow Omarchy is not merely "not themed": it is the desktop's window,
    // drawn from the same colours as before this feature existed.
    function test_follow_omarchy_draws_the_desktop_palette() {
      verify(!Paint.active, "nothing is picked")

      var painted = scene.paintedColours(surface, [])
      verify(painted.length > 0, "the tree paints something")
      verify(scene.paintColour(painted, Commons.Color.foreground),
        "a followed window paints the desktop's foreground")
      verify(scene.paintColour(painted, Qt.rgba(1, 1, 1, 1)) || scene.paintColour(painted, Qt.rgba(0, 0, 0, 1)),
        "and one of the desktop's own colours")
      // The helper delegation is exact, not approximate: these are the shell's
      // own answers, from the tokens the desktop baked.
      compare(String(Paint.hoverFillFor(Commons.Color.foreground, Commons.Color.accent)),
        String(Style.hoverFillFor(Commons.Color.foreground, Commons.Color.accent)))
      compare(String(Paint.normalBorderFor(Commons.Color.foreground, Commons.Color.accent)),
        String(Style.normalBorderFor(Commons.Color.foreground, Commons.Color.accent)))
      compare(String(Paint.popupBorder), String(Commons.Color.popups.border))
    }

    // Picking applies live and unpicking restores the original bindings — the
    // promise a dropdown that takes effect without a restart is making.
    function test_switching_back_and_forth_restores_the_bindings() {
      scene.followOmarchy()
      var desktopBorder = String(card.border.color)
      var desktopAccent = String(Paint.accent)

      scene.pickTheme("fixture-light")
      verify(String(card.border.color) !== desktopBorder,
        "the card's border followed the picked theme")

      scene.followOmarchy()
      compare(String(card.border.color), desktopBorder,
        "following again restores the card's border")
      compare(String(Paint.accent), desktopAccent)
      compare(String(Paint.popupBorder), String(Commons.Color.popups.border))
    }

    // A settings file is not a trusted theme name. Anything unusable is Follow
    // Omarchy, never an error state and never a path.
    function test_an_invalid_stored_theme_falls_back() {
      Paint.available = true
      Paint.themeName = "../../etc/passwd"
      compare(Paint.selected, "", "a traversing name is not a theme")
      // Even if a directory was handed over with it, there is no theme to read.
      Paint.themeDir = "/themes/../../etc/passwd"
      Paint.colorsText = ""
      Paint.shellText = ""
      Paint.rebuild()
      verify(!Paint.active, "an unreadable theme is Follow Omarchy")
      compare(String(Paint.foreground), String(Commons.Color.foreground))

      Paint.themeName = ".hidden"
      compare(Paint.selected, "")
      Paint.themeName = "not installed"
      compare(Paint.selected, "")
    }

    // The picker: Follow Omarchy first, then every installed theme by the name
    // a person reads, with the user's copy of a name winning over the installed
    // one.
    function test_the_picker_lists_user_and_system_themes() {
      var catalog = Qt.createQmlObject('import "../../theme"; ThemeCatalog {}', scene)
      catalog.roots = ["/home/u/.config/omarchy/themes", "/usr/share/omarchy/themes"]
      var found = catalog.parse([
        "/usr/share/omarchy/themes/nord/colors.toml",
        "/usr/share/omarchy/themes/catppuccin-latte/colors.toml",
        "/home/u/.config/omarchy/themes/nord/colors.toml",
        "/usr/share/omarchy/themes/../colors.toml",
      ].join("\n"))
      catalog.userThemes = found.user
      catalog.systemThemes = found.system

      compare(catalog.options[0].value, "", "Follow Omarchy is the first choice")
      compare(catalog.options[0].label, "Follow Omarchy")
      compare(catalog.options.length, 3, "one entry per name, plus the default")
      compare(catalog.options[1].label, "Catppuccin Latte")
      compare(catalog.options[2].label, "Nord")
      compare(catalog.directoryFor("nord"), "/home/u/.config/omarchy/themes/nord",
        "the user's copy of a name wins")
      compare(catalog.directoryFor("catppuccin-latte"), "/usr/share/omarchy/themes/catppuccin-latte")
      compare(catalog.directoryFor(""), "", "Follow Omarchy has no directory")
      compare(catalog.directoryFor(".."), "")
      catalog.destroy()
    }

    // The bar is the desktop's surface. Picking a theme for the window must not
    // reach it.
    function test_the_bar_keeps_the_desktop_palette() {
      var before = scene.paintedColours(barPreview, [])
      verify(before.length > 0, "the bar preview paints something")
      scene.pickTheme("fixture-light")
      var after = scene.paintedColours(barPreview, [])
      compare(after.length, before.length)
      for (var i = 0; i < before.length; i++) {
        compare(String(after[i].colour), String(before[i].colour),
          "bar colour at " + before[i].where + " did not change")
      }
      // Nothing in the bar came from the picked theme: its lines are the
      // desktop's, at the desktop's alphas.
      for (var j = 0; j < after.length; j++) verify(scene.isDesktopNeutral(after[j].colour),
        "the bar paints a desktop colour at " + after[j].where)
    }

    // The one part of the spin box the wrapper replaces, and the only part of it
    // that came from the shell's baked tokens.
    function test_number_field_background_follows_the_theme() {
      // The wrapper replaces the box's background rather than recolouring it, so
      // each state has to be read from the box afresh.
      scene.followOmarchy()
      verify(numberField.field.background !== null, "the spin box has a background")
      var shellsBackground = String(numberField.field.background.color)

      scene.pickTheme("fixture-light")
      compare(String(numberField.field.background.color),
        String(Paint.normalFillFor(Paint.foreground, Paint.accent)),
        "the box is drawn in the picked theme's own fill")
      verify(!scene.isDesktopNeutral(numberField.field.background.border.color),
        "its border is the window's, not the desktop's")

      scene.followOmarchy()
      compare(String(numberField.field.background.color), shellsBackground,
        "following again leaves the box the shell drew")
    }

    // ------------------------------------------------------------ the picker
    //
    // Follow -> a light theme -> Follow again -> a dark one, through the kit's
    // own dropdown. The shell's control assigns its own value when a row is
    // chosen, so the label a person reads is asserted separately from the
    // value the window stores.
    //
    // Each step waits for the state it is about to drive rather than for a
    // number of milliseconds. A popup that reports itself open is not yet
    // necessarily the thing the keyboard reaches, and this suite runs every
    // file in one process, so a fixed delay is a guess that can land early and
    // make the picker look broken when it is only late.
    function test_picker_round_trip() {
      scene.followOmarchy()
      scene.persistedTheme = ""
      wait(50)
      compare(themePicker.currentLabel(), "Follow Omarchy")
      verify(!Paint.active, "nothing is picked")

      themePicker.open()
      tryVerify(function() { return themePicker.popupOpen }, 2000,
        "the picker's popup opened")
      keyClick(Qt.Key_Down); keyClick(Qt.Key_Return)
      tryVerify(function() { return Paint.active }, 2000, "a theme was picked")
      compare(scene.persistedTheme, "fixture-light")
      compare(themePicker.currentLabel(), "Fixture Light")

      themePicker.open()
      tryVerify(function() { return themePicker.popupHasFocus }, 2000,
        "the themed popup's list holds the keyboard")
      keyClick(Qt.Key_Up); keyClick(Qt.Key_Return)
      tryVerify(function() { return !Paint.active }, 2000, "Follow Omarchy was picked again"
        + " (popup open: " + themePicker.popupOpen + ", picker value: \"" + themePicker.value
        + "\", label: \"" + themePicker.currentLabel() + "\")")
      compare(scene.persistedTheme, "")
      compare(themePicker.value, "")
      compare(themePicker.currentLabel(), "Follow Omarchy",
        "the picker reads the setting the window stored")
      compare(String(themePicker.children[0].value), "",
        "and the shell's own trigger was put in step with it")
      compare(themePicker.children[0].currentLabel(), "Follow Omarchy")

      themePicker.open()
      tryVerify(function() { return themePicker.popupOpen }, 2000,
        "the picker opens again after following")
      keyClick(Qt.Key_Down); keyClick(Qt.Key_Down); keyClick(Qt.Key_Return)
      tryVerify(function() { return Paint.active }, 2000, "a later selection still works")
      compare(scene.persistedTheme, "fixture-dark")
      compare(themePicker.currentLabel(), "Fixture Dark")
      compare(String(Paint.background), "#1e1e2e")
    }

    // The real settings page: its Appearance row is the picker, and its popup
    // is opened while a theme is picked.
    function test_the_real_settings_page_opens_the_picker() {
      scene.pickTheme("fixture-light"); wait(50)
      var picker = findChild(settingsPage, "app-theme-picker")
      verify(picker !== null, "the real settings page offers the theme picker")
      picker.open(); wait(60)
      verify(picker.popupOpen, "the picker's popup opens in a picked theme")
      picker.close(); wait(20)
      verify(!picker.popupOpen)
    }

    // The two views people spend the day in — the real list and the real
    // composer, not stand-ins for them. While following, the desktop's colours
    // are what they paint; with a theme picked, none of them may be. The first
    // half is what makes the second mean anything.
    function test_the_real_mail_list_and_composer_follow_the_picked_theme() {
      scene.followOmarchy(); wait(80)
      var following = scene.neutralColours(messageList)
      verify(following.length > 0,
        "following leaves the list on the desktop's palette")

      scene.pickTheme("fixture-light")
      // An opened composer with a draft in it. An empty one shows Qt's own
      // placeholder grey, which belongs to neither palette.
      var toField = findChild(composeView, "compose-to-field")
      var subjectField = findChild(composeView, "compose-subject-field")
      verify(toField !== null && subjectField !== null, "the composer offers its fields")
      toField.text = "ada@example.org"
      subjectField.text = "Quarterly report"
      wait(80)

      var listNeutral = scene.neutralColours(messageList)
      compare(listNeutral.length, 0,
        "the message list paints only the window's colours: " + listNeutral.join(", "))
      var composeNeutral = scene.neutralColours(composeView)
      compare(composeNeutral.length, 0,
        "the composer paints only the window's colours: " + composeNeutral.join(", "))
      compare(String(Paint.background), "#eff1f5", "and it is a picked theme being drawn")
    }

    // A chosen control keeps its non-colour indication: the current mailbox
    // stays bold, and the chosen calendar colour keeps its ring.
    function test_chosen_mailbox_keeps_its_bold_label() {
      scene.pickTheme("fixture-light"); wait(50)
      var label = scene.textItemFor(mailboxTabs, "Inbox")
      verify(label !== null, "the current mailbox draws its label")
      verify(label.font.bold, "a chosen mailbox stays bold while a theme is picked")

      scene.followOmarchy(); wait(50)
      var followed = scene.textItemFor(mailboxTabs, "Inbox")
      verify(followed !== null && followed.font.bold, "and stays bold while following")
    }

    function test_chosen_calendar_colour_keeps_its_ring() {
      var colorButton = findChild(calendarSettings, "calendar-source-color")
      verify(colorButton !== null, "the calendar row offers a colour")
      colorButton.forceActiveFocus(); keyClick(Qt.Key_Return); wait(50)
      var swatch = findChild(calendarSettings, "calendar-color-swatch-blue")
      verify(swatch !== null, "the palette shows the chosen colour")
      var ring = swatch.parent
      verify(ring.border.width > 0, "the chosen colour is ringed while following")

      scene.pickTheme("fixture-light"); wait(50)
      verify(swatch.parent.border.width > 0, "and keeps its ring while a theme is picked")
    }

    // ------------------------------------------------- borders and tooltips
    function test_button_border_and_tooltip_follow_the_picked_theme() {
      scene.followOmarchy(); wait(50)
      var shellBorder = String(borderedButton.border.color)
      var shellTip = String(borderedButton.tooltipForeground)
      scene.pickTheme("fixture-light"); wait(50)
      compare(String(borderedButton.border.color),
        String(Paint.normalBorderFor(Paint.foreground, Paint.accent)))
      compare(String(borderedButton.tooltipForeground), String(Paint.tooltipText))
      compare(String(borderedButton.tooltipBackground), String(Paint.tooltipBackground))

      scene.followOmarchy(); wait(50)
      compare(String(borderedButton.border.color), shellBorder,
        "following again leaves the shell's own border")
      compare(String(borderedButton.tooltipForeground), shellTip,
        "and the shell's own tooltip palette")
    }

    function test_open_tooltip_uses_the_window_palette() {
      scene.pickTheme("fixture-light"); wait(50)
      mouseMove(borderedButton, borderedButton.width / 2, borderedButton.height / 2); wait(600)
      var tip = findChild(borderedButton, "button-tooltip")
      verify(tip !== null, "the tooltip is the shell's own")
      verify(tip.visible, "hovering the button opens its tooltip")
      compare(String(tip.contentItem.color), String(Paint.tooltipText))
    }

    function test_number_field_selection_follows_the_theme() {
      scene.followOmarchy(); wait(50)
      var shellSelection = String(numberField.field.contentItem.selectionColor)
      scene.pickTheme("fixture-light"); wait(50)
      numberField.field.contentItem.forceActiveFocus()
      numberField.field.contentItem.selectAll(); wait(50)
      compare(String(numberField.field.contentItem.selectionColor),
        String(Paint.selectionFillFor(Paint.foreground, Paint.accent)))

      scene.followOmarchy(); wait(50)
      compare(String(numberField.field.contentItem.selectionColor), shellSelection,
        "following again restores the shell's own selection tint")
    }

    // ------------------------------------------------------- palette edges
    function test_a_palette_without_a_usable_foreground_falls_back() {
      Paint.available = true
      Paint.themeName = "broken"
      Paint.themeDir = "/themes/broken"
      Paint.colorsText = 'background = "#eff1f5"\nforeground = "garbage"\n'
      Paint.shellText = ""
      Paint.rebuild(); wait(20)
      verify(!Paint.active, "a theme with no usable foreground is not drawn with")
      compare(String(Paint.foreground), String(Commons.Color.foreground))
      compare(String(Paint.background), String(Commons.Color.background))
    }

    function test_the_roles_a_theme_leaves_out_are_filled() {
      Paint.available = true
      Paint.themeName = "sparse"
      Paint.themeDir = "/themes/sparse"
      Paint.colorsText = 'foreground = "#4c4f69"\nbackground = "#eff1f5"\n'
      Paint.shellText = ""
      Paint.rebuild(); wait(20)
      verify(Paint.active, "a drawable palette is a theme")
      compare(String(Paint.accent), "#4c4f69", "the accent falls back to the foreground")
      compare(String(Paint.urgent), "#4c4f69", "and so does the urgent colour")
    }

    function test_a_valid_theme_that_reloads_broken_falls_back() {
      scene.pickTheme("fixture-light"); wait(20)
      verify(Paint.active)
      // The file on disk lost its foreground while the window was open.
      Paint.colorsText = 'background = "#eff1f5"\nforeground = "garbage"\n'
      Paint.rebuild(); wait(20)
      verify(!Paint.active, "an incomplete reload is Follow Omarchy")
      compare(String(Paint.background), String(Commons.Color.background))
      compare(String(Paint.foreground), String(Commons.Color.foreground))
    }

    function test_colors_toml_active_border_reaches_the_popup() {
      Paint.available = true
      Paint.themeName = "border"
      Paint.themeDir = "/themes/border"
      Paint.colorsText = [
        'foreground = "#4c4f69"',
        'background = "#eff1f5"',
        'accent = "#8839ef"',
        'hyprland_active_border = "#123456 #654321 45deg"',
      ].join("\n")
      Paint.shellText = ""
      Paint.rebuild(); wait(20)
      compare(String(Paint.popupBorder), "#123456",
        "the popup takes the first colour of the active border")
    }

    function test_control_spec_keeps_the_live_alpha_and_geometry() {
      scene.pickTheme("fixture-light"); wait(20)
      var spec = Paint.controlSpec("normal", Paint.foreground, Paint.accent)
      compare(String(spec.color), String(Paint.normalBorderFor(Paint.foreground, Paint.accent)),
        "the stock alpha is the live one")
      compare(spec.widths.top, Style.normalBorderWidth)
      var previous = Style.normalBorderAlpha
      Style.normalBorderAlpha = 0.7
      var stronger = Paint.controlSpec("normal", Paint.foreground, Paint.accent)
      compare(stronger.color.a.toFixed(2), "0.70", "a non-default alpha is kept")
      Style.normalBorderAlpha = previous
    }

    // The colour walk, with the picker's popup open and a tooltip on screen:
    // neither may paint a desktop colour.
    function test_the_walk_with_an_open_popup_and_tooltip() {
      scene.pickTheme("fixture-light"); wait(50)
      themePicker.open(); wait(60)
      mouseMove(borderedButton, borderedButton.width / 2, borderedButton.height / 2); wait(600)
      var neutral = scene.neutralColours(surface)
      themePicker.close()
      compare(neutral.length, 0, "with a popup and a tooltip open the window still paints only its own colours: "
        + neutral.join(", "))
    }
  }
}
