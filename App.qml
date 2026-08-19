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
    ? String(manifest.id) : "gmail.omarchy"

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
  property bool plainTextForced: false
  property bool shortcutHelpVisible: false
  property bool setupVisible: false
  // Collapsed by default: a mail window spends its width on the list and the
  // message, not on six words that never change.
  property bool sidebarCollapsed: true

  readonly property bool ready: !!service && service.ready
  readonly property bool showSetup: setupVisible || !ready
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

  // Opening a message resets the two per-message reader toggles: a decision to
  // load images applies to the message it was made on, never to the next one.
  function openMessage(id) {
    if (!service) return
    plainTextForced = false
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
    if (currentView === "reader") service.select(next)
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
  }

  FloatingWindow {
    id: window
    visible: root.opened
    title: "Omarchy Gmail"
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

        Row {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(8)

          ActionIcon {
            anchors.verticalCenter: parent.verticalCenter
            name: "unread"
            iconSize: Style.font.iconLarge
            color: root.foreground
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.compact
            text: "Gmail"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
          }
        }

        SearchBar {
          id: searchBar
          anchors.centerIn: parent
          width: Math.min(Style.space(460), parent.width - Style.space(300))
          visible: !root.showSetup
          textColor: root.foreground
          accentColor: root.accent
          panelFontFamily: root.fontFamily
          onSubmitted: function(query) { if (root.service) root.service.search(query) }
          onCleared: if (root.service) root.service.search("")
        }

        Row {
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(4)

          IconButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showSetup
            iconName: "refresh"
            tooltipText: "Refresh"
            foreground: root.dim
            hoverColor: root.foreground
            fontFamily: root.fontFamily
            enabled: root.ready && !(root.service && root.service.listLoading)
            onClicked: if (root.service) root.service.refresh()
          }

          IconButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showSetup && root.compact
            iconName: "compose"
            tooltipText: "Compose"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: root.ready
            onClicked: root.startCompose("new")
          }

          IconTextButton {
            anchors.verticalCenter: parent.verticalCenter
            visible: !root.showSetup && !root.compact
            iconName: "compose"
            text: "Compose"
            foreground: root.foreground
            fontFamily: root.fontFamily
            enabled: root.ready
            onClicked: root.startCompose("new")
          }

          AppMenu {
            anchors.verticalCenter: parent.verticalCenter
            textColor: root.foreground
            panelFontFamily: root.fontFamily
            signedIn: root.ready
            onMarkAllReadRequested: if (root.service) root.service.markAllRead()
            onOpenWebRequested: if (root.service) root.service.openWebInbox()
            onShortcutsRequested: root.shortcutHelpVisible = true
            onSetupRequested: root.setupVisible = true
            onSignOutRequested: if (root.service) root.service.signOut()
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
          width: root.sidebarCollapsed ? Style.space(44) : Style.space(180)
          visible: !root.compact && !root.showSetup && !root.composing
          collapsed: root.sidebarCollapsed
          service: root.service
          textColor: root.foreground
          accentColor: root.accent
          dimColor: root.dim
          panelFontFamily: root.fontFamily
          onCollapseToggled: root.sidebarCollapsed = !root.sidebarCollapsed
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
          anchors.margins: Style.space(8)
          visible: root.compact && !root.showSetup && !root.composing && root.currentView === "list"
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
          // Proportional rather than fixed: at 1300px a 340px list truncates
          // every subject while the reader sits half empty, and at 800px a
          // wide list leaves the reader unusable. Clamped at both ends so the
          // column never becomes a sliver or a page of its own.
          width: root.compact
            ? (root.currentView === "list" ? parent.width : 0)
            : Math.max(Style.space(300),
                Math.min(Style.space(460), Math.round(parent.width * 0.34)))
          visible: width > 0 && !root.showSetup && !root.composing

          Flickable {
            id: listFlick
            anchors.fill: parent
            anchors.margins: Style.space(8)
            contentWidth: width
            contentHeight: list.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            MessageList {
              id: list
              width: listFlick.width
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

          // The far edge of the list. The rail draws its own on the other
          // side, so the three columns each end in one hairline.
          PanelSeparator {
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: 1
            visible: !root.compact
            foreground: root.foreground
          }
        }

        MessageReader {
          id: reader
          anchors.left: listColumn.visible ? listColumn.right : parent.left
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          visible: !root.showSetup && !root.composing
            && (!root.compact || root.currentView === "reader")
          service: root.service
          textColor: root.foreground
          backgroundColor: root.background
          accentColor: root.accent
          urgentColor: root.urgent
          linkColor: root.link
          dimColor: root.dim
          dimmerColor: root.dimmer
          panelFontFamily: root.fontFamily
          forcePlainText: root.plainTextForced
          showBack: root.compact
          onTogglePlainTextRequested: root.plainTextForced = !root.plainTextForced
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
          visible: root.composing && !root.showSetup
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
            canLeave: root.ready
            onBackRequested: root.setupVisible = false
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

        Text {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(14)
          anchors.right: notice.left
          anchors.rightMargin: Style.space(12)
          anchors.verticalCenter: parent.verticalCenter
          text: root.service && root.service.accountEmail !== ""
            ? root.service.accountEmail + " · " + root.service.inboxUnread + " unread"
            : "Not connected"
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        // One line for whatever the window most needs to say: what it is
        // doing, or what went wrong.
        Text {
          id: notice
          anchors.right: parent.right
          anchors.rightMargin: Style.space(14)
          anchors.verticalCenter: parent.verticalCenter
          width: Math.min(implicitWidth, parent.width / 2)
          horizontalAlignment: Text.AlignRight
          text: root.service
            ? (root.service.actionStatus !== "" ? root.service.actionStatus : root.service.lastError)
            : ""
          color: root.service && root.service.lastError !== "" && root.service.actionStatus === ""
            ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
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
        else if (root.composing) compose.finish()
        else if (root.currentView === "reader") root.backToList()
        else if (root.setupVisible) root.setupVisible = false
        else if (root.service && root.service.searchQuery !== "") root.service.search("")
        else root.requestClose()
        event.accepted = true
      }

      Shortcut { sequence: "Ctrl+K"; onActivated: searchBar.focusField() }
      Shortcut { sequence: "/"; enabled: !focusScope.typing; onActivated: searchBar.focusField() }
      Shortcut { sequence: "j"; enabled: !focusScope.typing; onActivated: root.moveCursor(1) }
      Shortcut { sequence: "k"; enabled: !focusScope.typing; onActivated: root.moveCursor(-1) }
      Shortcut { sequence: "Return"; enabled: !focusScope.typing && root.currentView === "list"; onActivated: root.openMessage(root.cursorId) }
      Shortcut { sequence: "u"; enabled: !focusScope.typing; onActivated: root.backToList() }
      Shortcut { sequence: "e"; enabled: !focusScope.typing; onActivated: root.actOnCursor("archive") }
      Shortcut { sequence: "#"; enabled: !focusScope.typing; onActivated: root.actOnCursor("trash") }
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
      Shortcut { sequence: "Ctrl+/"; onActivated: root.shortcutHelpVisible = !root.shortcutHelpVisible }
      Shortcut { sequence: "F5"; onActivated: if (root.service) root.service.refresh() }
    }
  }

}
