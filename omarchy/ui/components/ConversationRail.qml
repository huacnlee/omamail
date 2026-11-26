import QtQuick
import QtQuick.Controls
import qs.Commons
import "../account/Model.js" as Model

// The conversation beside the message, as a timeline down the right edge of the
// reader.
//
// A row stands for a conversation and opens one member of it; this is the rest
// of the conversation, newest first, every member a stop that opens in the same
// reader. It takes width from the body and never height: the message keeps its
// reading measure and the rail scrolls in a viewport of its own, the way the
// list scrolls beside the reader.
//
// It decides nothing. `account/Conversation.js` says which stops there are and
// what each of them shows; this draws them and reports which one was asked for.
Item {
  id: root

  // `Conversation.stops`: one entry per member, newest first, each carrying
  // whether its summary has arrived, whether it is the open message, and the
  // mailbox name it needs when it sits outside the one on screen.
  required property var stops
  // "3 messages · 1 unread", from the same file.
  required property string caption
  required property color textColor
  // The panel behind the rail, which is what a hollow node is filled with. A
  // literal would be a colour this file chose; the theme's is the one the
  // message beside it is drawn on.
  required property color backgroundColor
  required property color accentColor
  required property color dimColor
  required property color dimmerColor
  required property string panelFontFamily

  signal memberActivated(string id)
  // A right-click on a stop: the member's own menu, the one a row opens, at
  // the pointer. The rail reports the member and where; the reader passes it
  // up, and the App opens the menu it already has for rows.
  signal memberMenuRequested(string id, real sceneX, real sceneY)

  // About two hundred pixels: wide enough for a date, a name and a mailbox
  // under it, narrow enough that the reading measure beside it survives.
  implicitWidth: Style.space(200)

  // One animation for every skeleton on the rail, for the reason
  // `ReaderSkeleton` has one for the whole reader: a timer per bar puts a dozen
  // of them on the thread that draws the desktop.
  property real pulse: 0.5

  SequentialAnimation on pulse {
    running: root.visible && root.hasSkeleton
    loops: Animation.Infinite
    NumberAnimation { to: 1.0; duration: 900; easing.type: Easing.InOutQuad }
    NumberAnimation { to: 0.45; duration: 900; easing.type: Easing.InOutQuad }
  }

  readonly property bool hasSkeleton: {
    var list = root.stops || []
    for (var i = 0; i < list.length; i++) {
      if (!list[i].known) return true
    }
    return false
  }

  // Where one stop sits in the rail's own content, `{ y, height }`, or null for
  // an id that is not a stop. The same question `MessageList.boundsFor` answers
  // for a row, for the same reason: this is a Column in a Flickable, so there
  // is no index to position by and geometry is what a reveal has to go on.
  //
  // `node` and `line` are the stop's circle and its piece of the timeline in
  // the same coordinates, `{ top, bottom }` each, so a test can say where the
  // line begins and ends without reaching into the delegate.
  function boundsFor(id) {
    var wanted = String(id || "")
    for (var i = 0; i < stopColumn.children.length; i++) {
      var stop = stopColumn.children[i]
      if (!stop || stop.memberId !== wanted) continue
      return {
        y: stop.y, height: stop.height,
        node: { top: stop.y + stop.nodeTop, bottom: stop.y + stop.nodeBottom,
          centerX: stop.axis },
        line: { top: stop.y + stop.lineTop, bottom: stop.y + stop.lineBottom,
          x: stop.lineX, width: stop.lineWidth }
      }
    }
    return null
  }

  // Bring one stop on screen with the smallest scroll, and no scroll at all
  // while it is already there — the list cursor's own rule, called rather than
  // copied, because recentring on every step would drag the rail under
  // somebody walking one stop down it exactly as it would drag the list.
  function reveal(id) {
    var bounds = boundsFor(id)
    if (!bounds) return
    railFlick.contentY = Model.contentYToReveal(railFlick.contentY, railFlick.height,
      bounds.y, bounds.height, railFlick.contentHeight, Style.space(8))
  }

  // The rule separating the rail from the message, the full height of the pane.
  // Not a `PanelSeparator`: that one is a horizontal divider and fixes its own
  // height, which is the wrong half of the geometry to have decided for a rule
  // that runs down the edge. The tint is the same alpha-on-foreground.
  Rectangle {
    id: edge
    anchors.left: parent.left
    anchors.top: parent.top
    anchors.bottom: parent.bottom
    width: 1
    color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.12)
  }

  Text {
    id: captionText
    objectName: "railCaption"
    anchors.top: parent.top
    anchors.left: edge.right
    anchors.right: parent.right
    anchors.leftMargin: Style.space(12)
    anchors.rightMargin: Style.space(10)
    anchors.topMargin: Style.space(14)
    // Generated here out of a count, not written by a sender — but the rule is
    // cheap and the file it sits in draws senders two lines down.
    textFormat: Text.PlainText
    text: root.caption
    color: root.dimColor
    font.family: root.panelFontFamily
    font.pixelSize: Style.font.caption
    elide: Text.ElideRight
  }

  Flickable {
    id: railFlick
    objectName: "conversationRailFlick"
    anchors.top: captionText.bottom
    anchors.topMargin: Style.space(8)
    anchors.left: edge.right
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    contentWidth: width
    contentHeight: stopColumn.implicitHeight + Style.space(16)
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    Column {
      id: stopColumn
      width: railFlick.width
      spacing: 0

      Repeater {
        model: root.stops

        Stop {}
      }
    }
  }

  // One member. Not a button: it is a place on a timeline that can be gone to,
  // and the open one wears the list's own selected fill rather than a pressed
  // state.
  component Stop: Rectangle {
    id: stop

    required property var modelData
    required property int index
    readonly property string memberId: String(modelData.id || "")
    // The ends of the timeline. The line joins the stops; it does not run in
    // from above the first circle or out below the last, because there is
    // nothing at either end for it to be going to.
    readonly property bool first: index === 0
    readonly property bool last: index === (root.stops || []).length - 1
    readonly property real nodeTop: node.y
    readonly property real nodeBottom: node.y + node.height
    readonly property real lineTop: first ? nodeBottom : 0
    readonly property real lineBottom: last ? nodeTop : height
    // One axis for every stop, whatever size its circle is. The open circle is
    // wider than the others, and a segment centred on its own circle sat a
    // pixel to the side of the segments above and below it, which read as a
    // line that broke at the open message. The circle and the segment are
    // both centred on this instead, and the segment lands on a whole pixel so
    // it is one pixel wide rather than two half-shaded ones.
    readonly property real axis: Style.space(10) + Style.space(11) / 2
    readonly property real lineWidth: Math.max(1, Style.space(1))
    readonly property real lineX: Math.round(axis - lineWidth / 2)

    width: stopColumn.width
    implicitHeight: stopBody.implicitHeight + Style.space(14)
    height: implicitHeight
    radius: Style.cornerRadius
    color: modelData.open
      ? Style.selectedFillFor(root.textColor, root.accentColor)
      : (hover.containsMouse
        ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")

    MouseArea {
      id: hover
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      onClicked: function(event) {
        if (event.button === Qt.RightButton) {
          var scene = mapToGlobal(event.x, event.y)
          root.memberMenuRequested(stop.memberId, scene.x, scene.y)
        } else {
          root.memberActivated(stop.memberId)
        }
      }
    }

    // The timeline itself, drawn per stop rather than once behind them: the
    // rail scrolls, and a single rule sized to the content would have to be
    // kept in step with the Column. One segment per stop is the same line and
    // needs nothing kept true — the first stop's begins under its circle and
    // the last stop's ends above its own.
    Rectangle {
      id: segment
      objectName: "rail-segment"
      x: stop.lineX
      y: stop.lineTop
      width: stop.lineWidth
      height: Math.max(0, stop.lineBottom - stop.lineTop)
      color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.14)
    }

    // Filled with the accent while the member is unread, hollow once it has
    // been read, and heavier for the open one — three states, none of them
    // carried by colour alone: the open stop also has the selected fill behind
    // it and the word "open" beside its sender.
    Rectangle {
      id: node
      x: stop.axis - width / 2
      y: Style.space(13)
      width: modelData.open ? Style.space(11) : Style.space(9)
      height: width
      radius: width / 2
      color: modelData.unread ? root.accentColor : root.backgroundColor
      border.width: modelData.unread ? 0 : Math.max(1, Style.space(modelData.open ? 2 : 1))
      border.color: modelData.open ? root.textColor : root.dimColor
    }

    Column {
      id: stopBody
      anchors.left: parent.left
      anchors.leftMargin: node.x + Style.space(22)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(10)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      // The date leads, because the rail is a timeline and the date is where a
      // stop sits on it. The flag rides beside it: it belongs to the message
      // rather than to the person, and it is state the sender's own line must
      // not be able to imitate. The mailbox name, when the member has one to
      // show, takes the rest of this line rather than a line of its own — a
      // line that appeared when the summary landed moved every stop below it,
      // and in a search that was every stop.
      Item {
        width: parent.width
        implicitHeight: Math.max(dateText.implicitHeight, flagIcon.height,
          mailboxText.implicitHeight, dateBar.visible ? dateBar.height : 0)

        Text {
          id: dateText
          visible: stop.modelData.known
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          textFormat: Text.PlainText
          text: stop.modelData.time
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
        }

        Bar {
          id: dateBar
          visible: !stop.modelData.known
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          width: Math.max(1, parent.width * 0.34)
          height: Style.space(8)
        }

        ActionIcon {
          id: flagIcon
          visible: stop.modelData.flagged
          anchors.left: stop.modelData.known ? dateText.right : dateBar.right
          anchors.leftMargin: Style.space(5)
          anchors.verticalCenter: parent.verticalCenter
          name: "star"
          filled: true
          color: root.accentColor
          iconSize: Style.font.iconSmall
          fontFamily: root.panelFontFamily
        }

        // Where to find this member, when it is not where the reader is
        // looking. The account's own name for the mailbox, the one the sidebar
        // draws, against the right edge and elided rather than the date: the
        // date is where the stop sits and always fits.
        Text {
          id: mailboxText
          visible: stop.modelData.mailbox !== ""
          anchors.left: flagIcon.visible ? flagIcon.right
            : (stop.modelData.known ? dateText.right : dateBar.right)
          anchors.leftMargin: Style.space(8)
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          horizontalAlignment: Text.AlignRight
          textFormat: Text.PlainText
          text: stop.modelData.mailbox
          color: root.dimmerColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }

      Item {
        width: parent.width
        implicitHeight: Math.max(sender.implicitHeight, senderBar.visible ? senderBar.height : 0)

        Text {
          id: sender
          visible: stop.modelData.known
          anchors.left: parent.left
          anchors.right: openMark.visible ? openMark.left : parent.right
          anchors.rightMargin: openMark.visible ? Style.space(5) : 0
          // A stranger wrote this name. AutoText would promote anything
          // tag-shaped in it to rich text, and Qt's rich text engine fetches an
          // <img src> for real.
          textFormat: Text.PlainText
          text: stop.modelData.sender
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: stop.modelData.unread
          elide: Text.ElideRight
        }

        Bar {
          id: senderBar
          visible: !stop.modelData.known
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          width: Math.max(1, parent.width * 0.62)
          height: Style.space(9)
        }

        // The word, not only the fill: a theme whose selected surface is faint
        // would otherwise leave nothing at all saying which of these is the
        // message on screen.
        Text {
          id: openMark
          visible: stop.modelData.open && stop.modelData.known
          anchors.right: parent.right
          anchors.baseline: sender.baseline
          textFormat: Text.PlainText
          text: "open"
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }

  component Bar: Rectangle {
    radius: Style.cornerRadius
    color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b,
      0.06 + 0.05 * root.pulse)
  }
}
