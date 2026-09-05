import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../agent/Agent.js" as Agent
import "Menu.js" as Menu

// The one question the agent is asked about a message, and what it is doing
// once asked. A popup in the window rather than a window of its own, opened
// from the message's agent button; submitting starts the job and closes it,
// closing it starts nothing and stops nothing. Only Cancel actions stops.
Item {
  id: root

  required property color textColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  // The message the popup is about, and the job it has if it has one.
  property string messageId: ""
  property string subject: ""
  property var job: null

  readonly property bool opened: menu.opened
  readonly property bool working: Agent.isActive(job)
  readonly property string stateText: Agent.stateLabel(job)
  readonly property string detailText: Agent.detailText(job)

  signal asked(string messageId, string prompt)
  signal cancelRequested(string messageId)

  anchors.fill: parent
  z: 46

  property real anchorX: 0
  property real anchorY: 0

  function openFor(id, subjectText, sceneX, sceneY) {
    messageId = String(id || "")
    subject = String(subjectText || "")
    field.text = ""
    var local = root.mapFromGlobal(sceneX, sceneY)
    anchorX = local.x
    anchorY = local.y
    menu.open()
    place()
  }

  function openCenteredFor(id, subjectText) {
    messageId = String(id || "")
    subject = String(subjectText || "")
    field.text = ""
    anchorX = Math.max(0, (root.width - menu.width) / 2)
    anchorY = Math.max(0, (root.height - menu.implicitHeight) / 2)
    menu.open()
    place()
  }

  function place() {
    if (!menu.visible) return
    var tall = menu.height > 0 ? menu.height : menu.implicitHeight
    var placed = Menu.position(anchorX, anchorY, menu.width, tall, root.width, root.height)
    menu.x = placed.x
    menu.y = placed.y
  }

  function close() { menu.close() }

  function submit() {
    var prompt = String(field.text || "").trim()
    if (prompt === "" || messageId === "") return
    menu.close()
    root.asked(messageId, prompt)
  }

  QQC.Popup {
    id: menu
    width: Style.space(380)
    implicitHeight: column.implicitHeight + Style.space(24)
    padding: Style.space(12)
    modal: false
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    onHeightChanged: root.place()
    onOpened: {
      root.place()
      field.forceActiveFocus()
    }
    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }

    contentItem: Column {
      id: column
      spacing: Style.space(8)

      Text {
        width: parent.width
        textFormat: Text.PlainText
        // The subject was written by the sender.
        text: root.subject === "" ? "Ask the agent" : "Ask the agent about “" + root.subject + "”"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
        elide: Text.ElideRight
      }

      // What the job is doing, while there is one. State first, in words, and
      // then what the agent last said — its question, its error, or its
      // summary line.
      Column {
        width: parent.width
        visible: root.job !== null
        spacing: Style.space(2)

        Row {
          spacing: Style.space(6)

          ActionIcon {
            anchors.verticalCenter: parent.verticalCenter
            name: "agent"
            iconSize: Style.font.iconSmall
            color: Agent.glyphState(root.job) === "failed" ? root.urgentColor : root.accentColor
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: root.stateText
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
          }
        }

        Text {
          width: parent.width
          visible: root.detailText !== ""
          textFormat: Text.PlainText
          text: root.detailText
          color: Agent.glyphState(root.job) === "failed" ? root.urgentColor : root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
          maximumLineCount: 6
          elide: Text.ElideRight
        }
      }

      // The ask. Return submits; the popup's own Escape closes it.
      Rectangle {
        width: parent.width
        height: Style.spacing.controlHeight
        radius: Style.cornerRadius
        color: "transparent"
        border.width: 1
        border.color: field.activeFocus
          ? Style.hoverBorderFor(root.textColor, root.accentColor)
          : Style.normalBorderFor(root.textColor, root.accentColor)

        TextInput {
          id: field
          objectName: "agent-prompt-field"
          anchors.fill: parent
          anchors.leftMargin: Style.space(8)
          anchors.rightMargin: Style.space(8)
          verticalAlignment: TextInput.AlignVCenter
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.bodySmall
          clip: true
          selectByMouse: true
          onAccepted: root.submit()

          Text {
            anchors.fill: parent
            verticalAlignment: Text.AlignVCenter
            visible: field.text === "" && !field.activeFocus
            text: root.working ? "Ask something else about it" : "What should the agent do with this message?"
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
          }
        }
      }

      Row {
        width: parent.width
        spacing: Style.space(8)
        layoutDirection: Qt.RightToLeft

        Button {
          objectName: "agent-ask-button"
          text: root.working ? "Ask as well" : "Ask"
          tooltipText: "Start the agent on this message · Return"
          foreground: root.textColor
          bordered: true
          accent: root.accentColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          enabled: String(field.text || "").trim() !== "" && !root.working
          onClicked: root.submit()
        }

        // Only while something is running. Closing the popup does not do
        // this, and nothing else does either.
        Button {
          objectName: "agent-cancel-button"
          visible: root.working
          text: "Cancel actions"
          tooltipText: "Stop the agent and everything it is doing"
          foreground: root.urgentColor
          bordered: true
          accent: root.urgentColor
          fontFamily: root.panelFontFamily
          fontSize: Style.font.caption
          onClicked: {
            root.cancelRequested(root.messageId)
            menu.close()
          }
        }
      }
    }
  }
}
