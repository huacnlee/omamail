import QtQuick
import qs.Commons
import qs.Ui
import "../message/Direction.js" as Direction

// One message in the list. Unread is carried by weight and by the dot on the
// left, never by colour alone — the accent is a theme value that some themes
// put close to the foreground.
Rectangle {
  id: root

  required property var summary
  required property color textColor
  required property color accentColor
  required property color dimColor
  property color urgentColor: accentColor
  required property string panelFontFamily
  // Passed down rather than read off a service: a row draws one message and
  // has no other use for one.
  property bool canArchive: true
  property bool hasCursor: false
  property bool selected: false
  // Ticked for a bulk action. Not `selected`: that is the message the reader
  // shows, and the two are different things for the same reason the cursor is.
  property bool checked: false
  // What the agent is doing with this message, if anything: "", "running",
  // "question", "done", "failed" or "cancelled". State, so it shows whether
  // or not the row is hot, like the star.
  property string agentState: ""
  // The agent's last line while it works on this message, for the tooltip.
  property string agentProgress: ""
  // Whether any row in the list is ticked. While one is, every row shows its
  // box, so the lane the boxes sit in is the same on every row being compared.
  property bool selectionActive: false
  // How the direction of this message's own text is arrived at. Passed down
  // like every other fact a row draws, because a row decides nothing.
  property string contentDirection: Direction.MODE_DEFAULT

  signal activated()
  signal checkToggled()
  signal checkRangeRequested()
  signal starToggled()
  signal agentRequested(real sceneX, real sceneY)
  signal archiveRequested()
  signal trashRequested()
  signal menuRequested(real sceneX, real sceneY)

  // Hovered by a handler rather than by the MouseArea's `containsMouse`: a
  // button on the row has a MouseArea of its own, and the pointer moving onto
  // one took the row's hover away — the extra buttons hid, the lane closed,
  // the button slid out from under the pointer, the row was hovered again,
  // and the lane flickered open and shut. A HoverHandler is passive and stays
  // hovered whatever the pointer is over inside the row.
  readonly property bool hot: rowHover.hovered || hasCursor

  HoverHandler { id: rowHover }

  // The subject is asked on its own account: a reply prefix is Latin whatever
  // the thread is written in, so `Re: مرحبا` reads left-to-right to anything
  // that takes the first strong character at face value — which is every
  // message in a thread after the first.
  //
  // The sender and the snippet are not. Qt resolves both correctly from their
  // own text, so on Auto there is nothing to add; only a direction the reader
  // has actually chosen has to be carried to them.
  readonly property var subjectAlignment: alignmentFor(
    Direction.resolveSubject(root.summary.subject, root.contentDirection))
  readonly property var textAlignment: alignmentFor(
    Direction.forced(root.contentDirection))

  // `undefined` leaves a Text following the direction of its own text, which is
  // what should happen wherever there is no answer to give it.
  function alignmentFor(direction) {
    if (!Direction.hasAnswer(direction)) return undefined
    return Direction.isRightToLeft(direction) ? Text.AlignRight : Text.AlignLeft
  }

  width: parent ? parent.width : 0
  implicitHeight: body.implicitHeight + Style.space(14)
  radius: Style.cornerRadius
  // A ticked row is filled from the accent, but the tick is what says it is
  // ticked: some themes put the accent close to the foreground.
  color: selected
    ? Style.selectedFillFor(textColor, accentColor)
    : (checked
      ? Qt.rgba(accentColor.r, accentColor.g, accentColor.b, hot ? 0.22 : 0.14)
      : (hot ? Style.hoverFillFor(textColor, accentColor) : "transparent"))

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.MiddleButton | Qt.RightButton
    onClicked: function(event) {
      if (event.button === Qt.RightButton) {
        var scene = mapToGlobal(event.x, event.y)
        root.menuRequested(scene.x, scene.y)
      } else if (event.button === Qt.MiddleButton) {
        // Middle-click archives: the one triage action worth having without
        // moving the pointer to a button.
        root.archiveRequested()
      } else if (event.modifiers & Qt.ShiftModifier) {
        // Shift extends the selection from the cursor to here; Ctrl ticks
        // this row on its own. Both are the file manager's meaning of them.
        root.checkRangeRequested()
      } else if (event.modifiers & Qt.ControlModifier) {
        root.checkToggled()
      } else {
        root.activated()
      }
    }
  }

  Rectangle {
    anchors.left: parent.left
    anchors.leftMargin: Style.space(4)
    anchors.top: parent.top
    anchors.topMargin: Style.space(12)
    width: Style.space(5)
    height: width
    radius: width / 2
    // The box takes the dot's place while it is shown; unread is still
    // carried by the weight and the brighter subject.
    visible: root.summary.unread && !checkBox.visible
    color: root.accentColor
  }

  // The tick, in the lane the unread dot lives in so the text never moves.
  // Shown under the pointer or the cursor, and on every row while any row is
  // ticked, so a selection being built can be read down the column.
  Rectangle {
    id: checkBox
    objectName: "message-check"
    anchors.left: parent.left
    anchors.leftMargin: Style.space(1)
    anchors.top: parent.top
    anchors.topMargin: Style.space(10)
    width: Style.space(10)
    height: width
    radius: Style.space(2)
    visible: root.hot || root.checked || root.selectionActive
    color: root.checked ? Style.selectedFillFor(root.textColor, root.accentColor) : "transparent"
    border.width: Style.normalBorderWidth
    border.color: root.checked ? root.accentColor
      : (checkMouse.containsMouse ? root.textColor : root.dimColor)

    ActionIcon {
      anchors.centerIn: parent
      visible: root.checked
      name: "check"
      iconSize: Style.space(8)
      color: root.textColor
    }

    MouseArea {
      id: checkMouse
      anchors.fill: parent
      anchors.margins: -Style.space(3)
      hoverEnabled: true
      onClicked: function(event) {
        if (event.modifiers & Qt.ShiftModifier) root.checkRangeRequested()
        else root.checkToggled()
      }
    }

    PanelToolTip {
      visible: checkMouse.containsMouse
      text: (root.checked ? "Deselect" : "Select") + " · x (Shift+click a range, Ctrl+A all)"
      fontFamily: root.panelFontFamily
    }
  }

  Column {
    id: body
    anchors.left: parent.left
    anchors.right: actions.visible ? actions.left : parent.right
    // Matches the reader's content inset and the header's logo, so all three
    // columns start their text on one vertical line.
    anchors.leftMargin: Style.space(14)
    anchors.rightMargin: Style.space(8)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(2)

    // The subject leads. It is what the message is, and it is what you scan a
    // list for; the sender had the top line and the weight, which put the
    // emphasis on who wrote rather than on what about.
    Item {
      width: parent.width
      implicitHeight: Math.max(subject.implicitHeight, time.implicitHeight)

      Text {
        id: subject
        anchors.left: parent.left
        anchors.right: time.left
        anchors.rightMargin: Style.space(8)
        // A stranger wrote this. Qt's default AutoText switches a string that
        // looks like markup into rich text, and rich text with an <img> in it is
        // a fetch — the same beacon the message body is stripped of.
        textFormat: Text.PlainText
        text: root.summary.subject
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.body
        font.bold: root.summary.unread
        elide: Text.ElideRight
        horizontalAlignment: root.subjectAlignment
      }

      Text {
        id: time
        anchors.right: parent.right
        anchors.baseline: subject.baseline
        textFormat: Text.PlainText
        text: root.summary.time
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: root.summary.from.display
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
      horizontalAlignment: root.textAlignment
    }

    Text {
      width: parent.width
      visible: root.summary.snippet !== ""
      textFormat: Text.PlainText
      text: root.summary.snippet
      color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.42)
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      elide: Text.ElideRight
      maximumLineCount: 1
      horizontalAlignment: root.textAlignment
    }
  }

  // Row actions appear on hover or under the keyboard cursor. A starred
  // message keeps its star visible either way, because that is state rather
  // than an affordance.
  Row {
    id: actions
    anchors.right: parent.right
    anchors.rightMargin: Style.space(6)
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(1)
    visible: root.hot || root.summary.starred || root.agentState !== ""

    // The agent's glyph: a question waiting is the one state that asks for
    // the eye, so it is the urgent colour; running is the accent; the rest
    // are quiet. Clicking opens the popup on this message.
    IconButton {
      objectName: "row-agent"
      visible: root.agentState !== ""
      iconName: "agent"
      tooltipText: root.agentState === "running"
        ? (root.agentProgress !== "" ? root.agentProgress : "The agent is working on this")
        : root.agentState === "question" ? "The agent has a question"
        : root.agentState === "failed" ? "The agent failed on this"
        : root.agentState === "cancelled" ? "Agent actions were cancelled" : "The agent finished with this"
      foreground: root.agentState === "question" ? root.urgentColor
        : (root.agentState === "running" ? root.accentColor : root.dimColor)
      hoverColor: root.textColor
      iconSize: Style.font.iconSmall
      size: Style.space(24)
      fontFamily: root.panelFontFamily
      onClicked: {
        var scene = mapToGlobal(0, height)
        root.agentRequested(scene.x, scene.y)
      }
    }

    IconButton {
      iconName: "star"
      filled: root.summary.starred
      tooltipText: (root.summary.starred ? "Unstar" : "Star") + " · s"
      foreground: root.summary.starred ? root.accentColor : root.dimColor
      hoverColor: root.accentColor
      iconSize: Style.font.iconSmall
      size: Style.space(24)
      fontFamily: root.panelFontFamily
      onClicked: root.starToggled()
    }

    IconButton {
      // No archive button where the account has nowhere to archive to. On IMAP
      // that is a move to a folder, and a server without one would have this
      // quietly do nothing.
      visible: root.hot && root.canArchive
      iconName: "archive"
      tooltipText: "Archive · e"
      foreground: root.dimColor
      hoverColor: root.textColor
      iconSize: Style.font.iconSmall
      size: Style.space(24)
      fontFamily: root.panelFontFamily
      onClicked: root.archiveRequested()
    }

    IconButton {
      visible: root.hot
      iconName: "trash"
      tooltipText: "Move to trash · d"
      foreground: root.dimColor
      hoverColor: root.textColor
      iconSize: Style.font.iconSmall
      size: Style.space(24)
      fontFamily: root.panelFontFamily
      onClicked: root.trashRequested()
    }
  }
}
