import QtQuick
import QtQuick.Controls
import Quickshell
import qs.Commons
import qs.Ui

import "Model.js" as Model
import "components"

// The application window. The shell loads this entry point when the plugin is
// summoned and calls open()/close() on it; the FloatingWindow follows.
//
// Compose is a second window rather than a column. Hyprland tiles it beside
// the mailbox, so the message being answered stays on screen instead of being
// covered by the form.
Item {
  id: root

  property var shell: null
  property var manifest: null
  property var service: null
  property bool opened: false
  property bool closingFromHost: false

  readonly property string pluginId: manifest && manifest.id
    ? String(manifest.id) : "omamail"

  readonly property color foreground: Color.foreground
  readonly property color background: Color.background
  readonly property color accent: Color.accent
  readonly property color urgent: Color.urgent
  // Mixed toward the ground rather than Qt.darker: on a light theme darkening
  // an almost-black foreground makes secondary text heavier than body text.
  readonly property color dim: Qt.rgba(
    foreground.r * 0.68 + background.r * 0.32,
    foreground.g * 0.68 + background.g * 0.32,
    foreground.b * 0.68 + background.b * 0.32, 1)
  readonly property color dimmer: Qt.rgba(
    foreground.r * 0.45 + background.r * 0.55,
    foreground.g * 0.45 + background.g * 0.55,
    foreground.b * 0.45 + background.b * 0.55, 1)
  // Omarchy's palette has no separate "primary": `accent` is it. This theme's
  // accent is near fully saturated, which is right for a 5px unread dot and
  // wrong for a link sitting inside a paragraph. Same hue, same lightness,
  // capped saturation — calm enough to read past, still clearly a link.
  readonly property color link: Qt.hsla(accent.hslHue,
    Math.min(accent.hslSaturation, 0.55),
    accent.hslLightness, 1.0)

  readonly property string fontFamily: Style.font.family

  // Two breakpoints, not a continuum: three columns, list-plus-reader with the
  // sidebar collapsed to a strip, and a single column that swaps list for
  // reader.
  readonly property bool wide: window.width >= Style.space(1000)
  readonly property bool compact: window.width < Style.space(760)

  property string currentView: "list"
  property string cursorId: ""
  // Kept across messages: somebody who wants plain text wants it for their
  // mail, not for one message.
  property bool plainTextForced: false
  // Reading zoom for the message body only. The window's own chrome follows
  // the theme's font scale, which is Omarchy's to set, not this app's.
  property real bodyZoom: 1.0
  // 0 means "proportional"; anything else is a width somebody dragged to.
  property real listWidth: 0

  function zoomBy(step) {
    bodyZoom = Math.max(0.6, Math.min(2.5, Math.round((bodyZoom + step) * 20) / 20))
  }
  property bool shortcutHelpVisible: false
  property bool setupVisible: false
  property bool settingsVisible: false
  // Something the window needs to say that no account is reporting — refusing a
  // duplicate mailbox, for one. Cleared on a timer so it cannot outlive its
  // moment on the status line.
  property string notice: ""
  onNoticeChanged: if (notice !== "") noticeTimer.restart()
  // Open by default, but narrow. The longest mailbox name is "All mail" — at
  // 11px monospace that needs about 116px including the icon, the gaps and a
  // count, so the rail costs little enough to leave standing.
  //
  // The service owns it, because the service is what outlives the window: the
  // rail used to come back open on every restart, which is a preference the
  // user had already expressed and the window kept forgetting.
  readonly property bool sidebarCollapsed: !!service && service.sidebarCollapsed
  function toggleSidebar() {
    if (service) service.setSidebarCollapsed(!service.sidebarCollapsed)
  }

  readonly property bool ready: !!service && service.ready
  // The walkthrough is for having no mailbox at all. A mailbox that has been
  // added but not signed in yet belongs in settings, next to the ones that are.
  readonly property bool anyReady: !!service && service.anyAccountReady
  readonly property bool showSetup: setupVisible || !anyReady
  readonly property bool showSettings: settingsVisible && !showSetup
  // Anything the window goes *into*. The mail chrome stands down for all of it.
  readonly property bool showPage: showSetup || showSettings
  readonly property bool composing: compose.opened

  function open(payloadJson) {
    var payload = ({})
    try { payload = JSON.parse(String(payloadJson || "{}")) || ({}) } catch (e) {}
    closingFromHost = false
    opened = true
    if (service) service.windowOpen = true
    if (payload.mailbox && service) service.selectMailbox(String(payload.mailbox))
    if (payload.compose === true) startCompose("new")
    Qt.callLater(function() { focusScope.forceActiveFocus() })
  }

  function close() {
    closingFromHost = true
    opened = false
    if (service) service.windowOpen = false
    closingFromHost = false
  }

  function requestClose() {
    if (shell && typeof shell.hide === "function") shell.hide(pluginId)
    else close()
  }

  // Plain text is a preference and survives; the heavy-document override is a
  // per-message decision about one specific message and does not.
  function openMessage(id) {
    if (!service) return
    reader.forceRichAnyway = false
    cursorId = String(id || "")
    service.select(cursorId)
    currentView = "reader"
  }

  function backToList() {
    if (service) service.clearSelection()
    currentView = "list"
    Qt.callLater(function() { focusScope.forceActiveFocus() })
  }

  function moveCursor(delta) {
    if (!service) return
    var next = service.selectOffset(delta)
    if (next === "") return
    cursorId = next
    // Moving is not opening. This used to open whatever it landed on while the
    // reader was up, which made stepping through a list a way to mark half of
    // it read without having looked at any of it. Enter and "o" open.
  }

  function startCompose(mode) {
    compose.begin(String(mode || "new"),
      service ? service.selectedMessage : null,
      service ? service.selectedBody.text : "")
  }

  // Acting on the open message closes it: it is about to leave this list.
  function actOnCursor(action) {
    if (!service || cursorId === "") return
    var wasOpen = currentView === "reader" && service.selectedId === cursorId
    var next = service.selectOffset(1)
    service.act(cursorId, action)
    if (wasOpen && !Model.survivesAction(service.mailboxKey, action)) {
      if (next !== "" && next !== cursorId) openMessage(next)
      else backToList()
    }
  }

  function goMailbox(key) {
    if (!service) return
    service.selectMailbox(key)
    backToList()
  }

  Connections {
    target: root.service
    ignoreUnknownSignals: true
    function onReplySent() { compose.finish() }
    // A new account has no mailbox yet, so the only useful place to be is the
    // page that gives it one.
    // A new mailbox appears as a row in Settings, waiting to be signed in.
    // Sending the window to the first-run walkthrough instead showed a setup
    // that was already finished, for a different account.
    function onDuplicateAccount(email) {
      root.notice = email + " is already added"
    }
    function onAccountAdded() {
      root.setupVisible = false
      root.settingsVisible = true
    }
  }

  FloatingWindow {
    id: window
    visible: root.opened
    title: "Omamail"
    color: root.background
    implicitWidth: Style.space(980)
    implicitHeight: Style.space(720)
    minimumSize: Qt.size(Style.space(760), Style.space(520))

    onVisibleChanged: {
      if (!visible && root.opened && !root.closingFromHost) root.requestClose()
    }

    FocusScope {
      id: focusScope
      anchors.fill: parent
      focus: true

      // Every shortcut below is a bare letter, so all of them stand down while
      // text is being typed. The search field is the only input in this window
      // — compose is a window of its own — so it is the only thing to ask.
      readonly property bool typing: searchBar.fieldFocused || root.composing

      // ------------------------------------------------------------ header

      Item {
        id: header
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: Style.space(48)

        // Identity first, controls after, with a rule between them: the mark
        // and the name say what this window is, and everything to their right
        // does something.
        Row {
          id: headerLeft
          anchors.left: parent.left
          anchors.leftMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(8)

          ActionIcon {
            anchors.verticalCenter: parent.verticalCenter
            name: "gmail"
            iconSize: Style.font.iconLarge
            color: root.foreground
            brand: true
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.compact
            text: "Omamail"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
          }

          // Next to the mark: this is the window's own menu, not an action on
          // the mailbox. Anchored to the button's own edge so it lands in the
          // same place however the control was pressed.
          IconButton {
            id: menuButton
            anchors.verticalCenter: parent.verticalCenter
            iconName: "menu"
            tooltipText: "Menu"
            foreground: root.dim
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            selected: appMenu.opened
            onClicked: {
              var scene = mapToGlobal(0, height)
              appMenu.openAt(scene.x, scene.y)
            }
          }
        }

        // The slot is whatever the two clusters leave, so the field shrinks with
        // the window instead of running underneath Check mail. Centring it in
        // the header and reserving a fixed width could not work: the reserve is
        // split evenly either side, while the controls are all on the left.
        Item {
          id: searchSlot
          anchors.left: headerLeft.right
          anchors.right: headerRight.left
          anchors.leftMargin: Style.space(12)
          anchors.rightMargin: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter
          height: searchBar.implicitHeight

          SearchBar {
            id: searchBar
            anchors.verticalCenter: parent.verticalCenter
            // Centred on the header rather than on the gap, so it lines up with
            // the window instead of with whatever the controls happen to leave.
            // Clamped into the slot, which is what keeps it off Check mail when
            // the two clusters are not the same width.
            x: Math.max(0, Math.min(parent.width - width,
              (header.width - width) / 2 - parent.x))
            // Capped well short of the gap it is given: a search field as wide
            // as the window looks like the window's main event, and it is not.
            width: Math.min(Style.space(340), parent.width)
            // Below this it is a slot too small to type in; the shortcut still
            // works and reopens it as the window grows.
            visible: !root.showPage && parent.width >= Style.space(120)
          textColor: root.foreground
          accentColor: root.accent
          panelFontFamily: root.fontFamily
          // A search replaces the list, so the message still open in the
          // reader is almost certainly not in the results any more.
          onSubmitted: function(query) {
            if (!root.service) return
            root.service.search(query)
            root.backToList()
          }
          onCleared: {
            if (!root.service) return
            root.service.search("")
            root.backToList()
          }
          }
        }

        Row {
          id: headerRight
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(4)

          // Checking for mail and writing one are both things you do to the
          // mailbox as a whole, so they sit together. The menu is the window's
          // own, and it stays on the left with the mark.
          IconButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showPage
            iconName: "refresh"
            tooltipText: root.service && root.service.listLoading
              ? "Checking for mail…" : "Check mail · F5"
            foreground: root.dim
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            enabled: root.ready && !(root.service && root.service.listLoading)
            onClicked: if (root.service) root.service.refresh()
          }

          IconButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showPage
            iconName: "send"
            tooltipText: "Compose · c"
            foreground: root.dim
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            enabled: root.ready
            onClicked: root.startCompose("new")
          }

        }

        PanelSeparator {
          anchors.bottom: parent.bottom
          width: parent.width
          foreground: root.foreground
        }
      }

      // -------------------------------------------------------------- body

      Item {
        id: body
        anchors.top: header.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: statusBar.top

        MailboxSidebar {
          id: sidebar
          anchors.left: parent.left
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: root.sidebarCollapsed ? Style.space(44) : Style.space(148)
          visible: !root.compact && !root.showPage && !root.composing
          collapsed: root.sidebarCollapsed
          service: root.service
          textColor: root.foreground
          accentColor: root.accent
          dimColor: root.dim
          panelFontFamily: root.fontFamily
          switcherOpen: accountSwitcher.opened
          onSwitcherRequested: function(sceneX, sceneY) { accountSwitcher.openAt(sceneX, sceneY) }
          onMailboxSelected: function(key) { root.goMailbox(key) }
          onLabelSelected: function(labelId, name) {
            root.service.search("label:" + name)
            root.backToList()
          }
        }

        // Narrow windows lose the sidebar; the same mailboxes come back as a
        // scrolling strip above the list.
        MailboxTabs {
          id: tabs
          anchors.top: parent.top
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.margins: Style.space(14)
          visible: root.compact && !root.showPage && !root.composing && root.currentView === "list"
          textColor: root.foreground
          panelFontFamily: root.fontFamily
          current: root.service ? root.service.mailboxKey : "inbox"
          unread: root.service ? root.service.inboxUnread : 0
          onSelected: function(key) { root.goMailbox(key) }
        }

        Item {
          id: listColumn
          anchors.left: sidebar.visible ? sidebar.right : parent.left
          anchors.top: tabs.visible ? tabs.bottom : parent.top
          anchors.bottom: parent.bottom
          anchors.topMargin: tabs.visible ? Style.space(8) : 0
          // Proportional until somebody drags the divider, then whatever they
          // dragged it to. The floor is low on purpose: at a hundred pixels the
          // column is a strip of times and initials, which is a legitimate way
          // to work when the message is what you are reading. Refusing to go
          // there was the app deciding how someone else should use their screen.
          width: root.compact
            ? (root.currentView === "list" ? parent.width : 0)
            : Math.max(Style.space(100),
                Math.min(parent.width - Style.space(360),
                  root.listWidth > 0 ? root.listWidth
                    : Math.min(Style.space(460), Math.round(parent.width * 0.34))))
          visible: width > 0 && !root.showPage && !root.composing

          // The scroller fills the column so its bar sits on the column edge;
          // the breathing room is padding on the content, not a margin on the
          // viewport, which would push the bar inward with it.
          Flickable {
            id: listFlick
            anchors.fill: parent
            contentWidth: width
            contentHeight: list.implicitHeight + Style.space(16)
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            MessageList {
              id: list
              y: Style.space(8)
              // Full width, so a row's hover fill runs to the column edge the
              // way the sidebar's does; the text inset lives inside the row.
              // A gutter on the right keeps a row from sliding under the bar.
              width: listFlick.width - Style.space(14)
              service: root.service
              textColor: root.foreground
              accentColor: root.accent
              dimColor: root.dim
              panelFontFamily: root.fontFamily
              cursorId: root.cursorId
              onMessageActivated: function(id) { root.openMessage(id) }
              onRowHovered: function(id, isHovered) { if (isHovered) root.cursorId = id }
              onMenuRequested: function(id, sceneX, sceneY) {
                root.cursorId = id
                rowMenu.openAt(id, sceneX, sceneY)
              }
            }
          }

        }

        // The divider between the list and the message, and the handle that
        // moves it. A hairline is the right thing to look at and the wrong
        // thing to aim at, so the grab area is wider than the rule it draws.
        Item {
          id: listSplitter
          anchors.left: listColumn.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: Style.space(5)
          visible: listColumn.visible && !root.compact
          z: 5

          PanelSeparator {
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: 1
            foreground: root.foreground
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.SplitHCursor
            property real grabbedAt: 0
            property real grabbedWidth: 0

            onPressed: function(mouse) {
              grabbedAt = mapToItem(body, mouse.x, mouse.y).x
              grabbedWidth = listColumn.width
            }
            onPositionChanged: function(mouse) {
              if (!pressed) return
              var moved = mapToItem(body, mouse.x, mouse.y).x - grabbedAt
              root.listWidth = grabbedWidth + moved
            }
            // Back to the proportional default, which is what most people
            // want after one bad drag.
            onDoubleClicked: root.listWidth = 0
          }
        }

        MessageReader {
          id: reader
          anchors.left: listSplitter.visible ? listSplitter.right : parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          visible: !root.showPage && !root.composing
            && (!root.compact || root.currentView === "reader")
          service: root.service
          textColor: root.foreground
          backgroundColor: root.background
          accentColor: root.accent
          linkColor: root.link
          dimColor: root.dim
          dimmerColor: root.dimmer
          panelFontFamily: root.fontFamily
          zoom: root.bodyZoom
          showBack: root.compact
          forcePlainText: root.plainTextForced
          onTogglePlainTextRequested: root.plainTextForced = !root.plainTextForced
          onZoomRequested: function(step) { root.zoomBy(step) }
          onZoomResetRequested: root.bodyZoom = 1.0
          onBackRequested: root.backToList()
          onComposeRequested: function(mode) { root.startCompose(mode) }
          onActionRequested: function(action) {
            if (root.service && root.service.selectedId !== "") {
              root.cursorId = root.service.selectedId
              root.actOnCursor(action)
            }
          }
        }

        // Composing takes the whole body. Omarchy's panel mechanism would give
        // a second window its own region, which is not what a reply is.
        ComposeView {
          id: compose
          anchors.fill: parent
          visible: root.composing && !root.showPage
          service: root.service
          textColor: root.foreground
          backgroundColor: root.background
          accentColor: root.accent
          dimColor: root.dim
          dimmerColor: root.dimmer
          panelFontFamily: root.fontFamily
        }

        // Setup takes the whole body: there is nothing else to look at until
        // the mailbox is connected.
        Flickable {
          id: setupFlick
          anchors.fill: parent
          anchors.margins: Style.space(18)
          visible: root.showSetup
          contentWidth: width
          contentHeight: setupHolder.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          // A holder the width of the viewport, so the page below can centre
          // against something real. Anchoring beats arithmetic here: a
          // Flickable reparents its children, and an x binding written against
          // the Flickable's own width lands before that reparenting settles.
          Item {
            id: setupHolder
            width: setupFlick.width
            implicitHeight: setup.implicitHeight

          SetupPage {
            id: setup
            // A measure this long is unreadable across a wide window, so it is
            // capped rather than stretched.
            anchors.horizontalCenter: parent.horizontalCenter
            width: Math.min(setupHolder.width, Style.space(560))
            service: root.service
            textColor: root.foreground
            dimColor: root.dim
            panelFontFamily: root.fontFamily
            canLeave: root.anyReady
            onBackRequested: root.setupVisible = false
          }
          }
        }

        // The settings page, which is where mailboxes are added and removed.
        Flickable {
          id: settingsFlick
          anchors.fill: parent
          anchors.margins: Style.space(18)
          visible: root.showSettings
          contentWidth: width
          contentHeight: settingsHolder.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Item {
            id: settingsHolder
            width: settingsFlick.width
            implicitHeight: settings.implicitHeight

            SettingsPage {
              id: settings
              anchors.horizontalCenter: parent.horizontalCenter
              width: Math.min(settingsHolder.width, Style.space(560))
              service: root.service
              textColor: root.foreground
              dimColor: root.dim
              accentColor: root.accent
              urgentColor: root.urgent
              panelFontFamily: root.fontFamily
              onBackRequested: root.settingsVisible = false
              onClientSetupRequested: root.setupVisible = true
              onAddRequested: if (root.service) root.service.addAccount()
              onSignInRequested: function(index) {
                if (!root.service) return
                root.service.switchToIndex(index)
                root.service.signIn()
              }
              onSignOutRequested: function(index) {
                if (!root.service) return
                root.service.switchToIndex(index)
                root.service.signOut()
              }
              onRemoveRequested: function(index) {
                if (root.service) root.service.removeAccountAt(index)
              }
            }
          }
        }
      }

      // --------------------------------------------------------- status bar

      Item {
        id: statusBar
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        height: Style.space(28)

        PanelSeparator {
          anchors.top: parent.top
          width: parent.width
          foreground: root.foreground
        }

        // The rail's own switch, at the far left of the status line. On the rail
        // it cost a whole row above the mailboxes; in the header it was a
        // button about the sidebar sitting among buttons about the mailbox.
        // The status line is where a view toggle belongs.
        IconButton {
          id: railToggle
          anchors.left: parent.left
          anchors.leftMargin: Style.space(8)
          anchors.verticalCenter: parent.verticalCenter
          visible: !root.compact && !root.showPage && !root.composing
          iconName: "sidebar"
          tooltipText: root.sidebarCollapsed ? "Show the sidebar" : "Hide the sidebar"
          // No fill for the open state. The sidebar standing there is the state,
          // said far better than a lit square on the status line could say it,
          // and this control has no business drawing attention to itself.
          foreground: root.dim
          hoverColor: root.foreground
          iconSize: Style.font.iconSmall
          size: Style.space(20)
          fontFamily: root.fontFamily
          onClicked: root.toggleSidebar()
        }

        Text {
          id: accountLine
          anchors.left: railToggle.visible ? railToggle.right : parent.left
          anchors.leftMargin: railToggle.visible ? Style.space(8) : Style.space(14)
          // An invisible sibling still holds its place, so the hints must only
          // take room from this line while they are actually on screen.
          anchors.right: statusBar.hasNotice
            ? notice.left
            : (keyHints.visible ? keyHints.left : parent.right)
          anchors.rightMargin: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter
          // The account already has a home in the sidebar's user bar, so this
          // says something the window does not say anywhere else: how current
          // the list is. When the sidebar is hidden it takes the account back,
          // because then nothing else is carrying it.
          text: {
            if (!root.service) return "Not connected"
            if (!root.ready) return "Not connected"
            if (root.compact)
              return root.service.accountEmail + " · " + root.service.inboxUnread + " unread"
            return Model.statusSummary(root.service.syncedLabel,
              root.service.resultSummary, root.service.listLoading)
          }
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight

        }

        // The right of the status line carries one of two things: what the
        // window most needs to say, or — when it has nothing to report — what
        // the keyboard can do from where you are standing.
        readonly property bool hasNotice: root.notice !== ""
          || (!!root.service
            && (root.service.actionStatus !== "" || root.service.lastError !== ""))

        Text {
          id: notice
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          visible: statusBar.hasNotice
          width: Math.min(implicitWidth, parent.width / 2)
          horizontalAlignment: Text.AlignRight
          text: {
            if (root.notice !== "") return root.notice
            if (!root.service) return ""
            if (root.service.actionStatus !== "") return root.service.actionStatus
            return root.service.lastError
          }
          color: root.service && root.service.lastError !== "" && root.service.actionStatus === ""
            ? root.urgent
            : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        KeyHints {
          id: keyHints
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          visible: !statusBar.hasNotice && !root.compact
          textColor: root.foreground
          dimColor: root.dimmer
          panelFontFamily: root.fontFamily
          hints: {
            if (root.showPage) return [({ key: "Esc", label: "back" })]
            if (root.composing) return [
              ({ key: "Ctrl+Enter", label: "send" }),
              ({ key: "Esc", label: "close" })
            ]
            if (root.currentView === "reader") return [
              ({ key: "Esc", label: "back" }),
              ({ key: "r", label: "reply" }),
              ({ key: "e", label: "archive" }),
              ({ key: "d", label: "trash" })
            ]
            return [
              ({ key: "j / k", label: "move" }),
              ({ key: "o", label: "open" }),
              ({ key: "e", label: "archive" }),
              ({ key: "c", label: "compose" })
            ]
          }
        }
      }

      // The account menu. It has no trigger of its own: the sidebar's user bar
      // opens it, and so does the status bar when the sidebar is hidden.
      AppMenu {
        id: appMenu
        anchors.fill: parent
        textColor: root.foreground
        panelFontFamily: root.fontFamily
        signedIn: root.ready
        accountCount: root.service ? root.service.accountCount : 1
        onMarkAllReadRequested: if (root.service) root.service.markAllRead()
        onOpenWebRequested: if (root.service) root.service.openWebInbox()
        onShortcutsRequested: root.shortcutHelpVisible = true
        onSetupRequested: root.settingsVisible = true
        onSwitchAccountRequested: accountSwitcher.openCentered()
        onProjectRequested: if (root.service) root.service.openProjectPage()
        onAuthorRequested: if (root.service) root.service.openAuthorPage()
      }

      // Every mailbox, with its own unread count, opened from the user bar.
      Timer {
        id: noticeTimer
        interval: 6000
        onTriggered: root.notice = ""
      }

      AccountSwitcher {
        id: accountSwitcher
        anchors.fill: parent
        textColor: root.foreground
        accentColor: root.accent
        urgentColor: root.urgent
        dimColor: root.dim
        panelFontFamily: root.fontFamily
        accounts: root.service ? root.service.accountSummaries : []
        onAccountChosen: function(index) {
          if (root.service) root.service.switchToIndex(index)
          root.backToList()
        }
        onAddAccountRequested: if (root.service) root.service.addAccount()
        onRemoveAccountRequested: function(index) {
          if (root.service) root.service.removeAccountAt(index)
        }
      }

      MessageMenu {
        id: rowMenu
        service: root.service
        textColor: root.foreground
        urgentColor: root.urgent
        dimColor: root.dim
        panelFontFamily: root.fontFamily
        onComposeRequested: function(mode, id) {
          root.openMessage(id)
          root.startCompose(mode)
        }
        onActionRequested: function(action, id) {
          root.cursorId = id
          root.actOnCursor(action)
        }
      }

      ShortcutHelp {
        anchors.fill: parent
        visible: root.shortcutHelpVisible
        textColor: root.foreground
        backgroundColor: root.background
        dimColor: root.dim
        panelFontFamily: root.fontFamily
        onDismissed: root.shortcutHelpVisible = false
      }

      // ---------------------------------------------------------- keyboard

      Keys.onEscapePressed: function(event) {
        if (root.shortcutHelpVisible) root.shortcutHelpVisible = false
        else if (rowMenu.opened) rowMenu.close()
        else if (appMenu.opened) appMenu.close()
        else if (accountSwitcher.opened) accountSwitcher.close()
        else if (root.composing) compose.finish()
        else if (root.currentView === "reader") root.backToList()
        else if (root.setupVisible) root.setupVisible = false
        else if (root.settingsVisible) root.settingsVisible = false
        else if (root.service && root.service.searchQuery !== "") root.service.search("")
        else root.requestClose()
        event.accepted = true
      }

      Shortcut { sequence: "Ctrl+K"; onActivated: searchBar.focusField() }
      Shortcut { sequence: "/"; enabled: !focusScope.typing; onActivated: searchBar.focusField() }
      Shortcut { sequence: "j"; enabled: !focusScope.typing; onActivated: root.moveCursor(1) }
      Shortcut { sequence: "k"; enabled: !focusScope.typing; onActivated: root.moveCursor(-1) }
      Shortcut { sequence: "Return"; enabled: !focusScope.typing && root.currentView === "list"; onActivated: root.openMessage(root.cursorId) }
      // "o" for open, next to j/k on the home row, so the whole read cycle can
      // be driven without leaving it.
      Shortcut { sequence: "o"; enabled: !focusScope.typing && root.currentView === "list"; onActivated: root.openMessage(root.cursorId) }
      Shortcut { sequence: "e"; enabled: !focusScope.typing; onActivated: root.actOnCursor("archive") }
      Shortcut { sequence: "d"; enabled: !focusScope.typing; onActivated: root.actOnCursor("trash") }
      Shortcut { sequence: "s"; enabled: !focusScope.typing; onActivated: if (root.service) root.service.toggleStar(root.cursorId) }
      Shortcut { sequence: "Shift+I"; enabled: !focusScope.typing; onActivated: root.actOnCursor("markRead") }
      Shortcut { sequence: "Shift+U"; enabled: !focusScope.typing; onActivated: root.actOnCursor("markUnread") }
      Shortcut { sequence: "r"; enabled: !focusScope.typing && root.currentView === "reader"; onActivated: root.startCompose("reply") }
      Shortcut { sequence: "a"; enabled: !focusScope.typing && root.currentView === "reader"; onActivated: root.startCompose("replyAll") }
      Shortcut { sequence: "f"; enabled: !focusScope.typing && root.currentView === "reader"; onActivated: root.startCompose("forward") }
      Shortcut { sequence: "c"; enabled: !focusScope.typing; onActivated: root.startCompose("new") }
      Shortcut { sequence: "g,i"; enabled: !focusScope.typing; onActivated: root.goMailbox("inbox") }
      Shortcut { sequence: "g,s"; enabled: !focusScope.typing; onActivated: root.goMailbox("starred") }
      Shortcut { sequence: "g,u"; enabled: !focusScope.typing; onActivated: root.goMailbox("unread") }
      Shortcut { sequence: "g,t"; enabled: !focusScope.typing; onActivated: root.goMailbox("sent") }
      Shortcut { sequence: "Ctrl++"; onActivated: root.zoomBy(0.1) }
      Shortcut { sequence: "Ctrl+="; onActivated: root.zoomBy(0.1) }
      Shortcut { sequence: "Ctrl+-"; onActivated: root.zoomBy(-0.1) }
      Shortcut { sequence: "Ctrl+0"; onActivated: root.bodyZoom = 1.0 }
      Shortcut { sequence: "Ctrl+/"; onActivated: root.shortcutHelpVisible = !root.shortcutHelpVisible }
      Shortcut { sequence: "Ctrl+?"; onActivated: root.shortcutHelpVisible = !root.shortcutHelpVisible }
      Shortcut { sequence: "F5"; onActivated: if (root.service) root.service.refresh() }
    }
  }

}
