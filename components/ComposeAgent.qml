import QtQuick
import QtQuick.Controls
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../agent/Agent.js" as Agent

// The agent beside a draft: a floating card over the composer that takes an
// ask about the draft as it stands — review it, rewrite it, shorten it,
// write it from notes, or anything typed — and hands the answer back to be
// put into the draft, or read. It floats because the draft has to stay
// visible and editable while the answer is read against it, and it is
// dragged by its title bar so it can sit wherever the draft is not.
Item {
  id: root

  required property color textColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  property var service: null
  // Read from the composer when an ask is made, and written back on apply.
  property var fields: ({ to: "", subject: "", body: "" })

  readonly property bool opened: card.opened
  readonly property var jobs: service ? service.agentDraftJobs : []
  readonly property var job: jobs.length > 0 ? jobs[0] : null
  readonly property bool working: Agent.isActive(job)
  readonly property string output: service && job && service.agentShownId === String(job.id)
    ? service.agentShownOutput : ""
  readonly property string answer: Agent.draftAnswer(job, output)

  signal askRequested(string ask)
  signal replaceRequested(string text)
  signal insertRequested(string text)
  signal looked(string jobId)

  anchors.fill: parent
  z: 60

  function open() {
    if (!card.opened) {
      card.x = Math.max(Style.space(16), root.width - card.width - Style.space(24))
      card.y = Style.space(72)
      card.open()
    }
    askField.forceActiveFocus()
  }

  function close() { card.close() }

  function ask(text) {
    var prompt = String(text || "").trim()
    if (prompt === "") return
    root.askRequested(prompt)
    askField.text = ""
  }

  onJobChanged: if (service && job) { service.showAgentJob(String(job.id)); if (opened) root.looked(String(job.id)) }
  onOpenedChanged: if (opened && job) root.looked(String(job.id))

  QQC.Popup {
    id: card
    width: Math.min(Style.space(420), root.width - Style.space(32))
    height: Math.min(Style.space(460), root.height - Style.space(96))
    padding: 0
    modal: false
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape
    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }

    contentItem: Item {
      // The title bar is the handle. Dragging moves the whole card; the
      // popup's own coordinates are what move, clamped to the window.
      Rectangle {
        id: titleBar
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: Style.space(32)
        radius: Style.cornerRadius
        color: Style.normalFillFor(root.textColor, root.accentColor)

        Row {
          anchors.left: parent.left
          anchors.leftMargin: Style.space(10)
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.space(6)

          ActionIcon {
            anchors.verticalCenter: parent.verticalCenter
            name: "agent"
            iconSize: Style.font.iconSmall
            color: root.working ? root.accentColor : root.textColor
          }

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: root.working ? "Agent · " + Agent.stateLabel(root.job) : "Agent"
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
          }
        }

        IconButton {
          anchors.right: parent.right
          anchors.rightMargin: Style.space(4)
          anchors.verticalCenter: parent.verticalCenter
          iconName: "close"
          tooltipText: "Close · Esc"
          foreground: root.dimColor
          hoverColor: root.textColor
          iconSize: Style.font.iconSmall
          size: Style.space(24)
          fontFamily: root.panelFontFamily
          onClicked: card.close()
        }

        DragHandler {
          target: null
          onTranslationChanged: {
            card.x = Math.max(0, Math.min(root.width - card.width, card.x + translation.x - lastX))
            card.y = Math.max(0, Math.min(root.height - card.height, card.y + translation.y - lastY))
            lastX = translation.x
            lastY = translation.y
          }
          onActiveChanged: if (!active) { lastX = 0; lastY = 0 }
          property real lastX: 0
          property real lastY: 0
        }
      }

      Column {
        id: body
        anchors.top: titleBar.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: Style.space(10)
        spacing: Style.space(8)

        // The quick asks: one button each, the prompt behind it exactly what
        // the label says.
        Flow {
          width: parent.width
          spacing: Style.space(6)

          Repeater {
            model: Agent.draftAsks()

            Button {
              required property var modelData
              text: modelData.label
              tooltipText: modelData.prompt
              foreground: root.textColor
              bordered: true
              accent: root.accentColor
              fontFamily: root.panelFontFamily
              fontSize: Style.font.caption
              enabled: !root.working
              onClicked: root.ask(modelData.prompt)
            }
          }
        }

        Row {
          width: parent.width
          spacing: Style.space(6)

          TextField {
            id: askField
            objectName: "compose-agent-ask"
            width: parent.width - askButton.width - parent.spacing
            foreground: root.textColor
            accent: root.accentColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            placeholderText: "Or ask anything about this draft"
            onAccepted: root.ask(text)
          }

          Button {
            id: askButton
            anchors.verticalCenter: parent.verticalCenter
            text: "Ask"
            foreground: root.textColor
            bordered: true
            accent: root.accentColor
            fontFamily: root.panelFontFamily
            fontSize: Style.font.caption
            enabled: String(askField.text || "").trim() !== "" && !root.working
            onClicked: root.ask(askField.text)
          }
        }

        // The answer, or the way there: progress while it works, the
        // question or error when it stops, the text when it is done.
        Rectangle {
          width: parent.width
          height: body.height - y
          radius: Style.cornerRadius
          color: Style.normalFillFor(root.textColor, root.accentColor)

          Flickable {
            id: answerFlick
            WheelScroller { view: answerFlick }
            anchors.fill: parent
            anchors.margins: Style.space(8)
            anchors.bottomMargin: applyRow.visible ? applyRow.height + Style.space(12) : Style.space(8)
            contentWidth: width
            contentHeight: answerText.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

            Text {
              id: answerText
              width: answerFlick.width
              textFormat: Text.PlainText
              text: {
                if (!root.job) return "Ask for a review or a rewrite, and the answer appears here."
                var stall = Agent.stallText(root.job)
                if (stall !== "") return stall
                if (root.working) {
                  var progress = Agent.progressText(root.job)
                  return progress !== "" ? progress : "Working"
                }
                if (root.answer !== "") return root.answer
                return Agent.detailText(root.job)
              }
              color: Agent.glyphState(root.job) === "failed" || Agent.stallText(root.job) !== ""
                ? root.urgentColor : root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
          }

          // What to do with the answer. Replace and insert change the draft;
          // Copy is for a review that should not.
          Row {
            id: applyRow
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.margins: Style.space(8)
            spacing: Style.space(6)
            visible: root.answer !== "" || root.working

            Button {
              visible: root.working
              text: "Cancel actions"
              foreground: root.urgentColor
              bordered: true
              accent: root.urgentColor
              fontFamily: root.panelFontFamily
              fontSize: Style.font.caption
              onClicked: if (root.service && root.job) root.service.cancelAgentJob(String(root.job.id))
            }

            Button {
              visible: root.answer !== ""
              text: "Insert at cursor"
              foreground: root.textColor
              bordered: true
              accent: root.accentColor
              fontFamily: root.panelFontFamily
              fontSize: Style.font.caption
              onClicked: root.insertRequested(root.answer)
            }

            Button {
              visible: root.answer !== ""
              text: "Replace body"
              foreground: root.textColor
              bordered: true
              accent: root.accentColor
              fontFamily: root.panelFontFamily
              fontSize: Style.font.caption
              onClicked: root.replaceRequested(root.answer)
            }
          }
        }
      }
    }
  }
}
