import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../agent/Agent.js" as Agent

// The agent pane: an ask across the open mailbox or every mailbox, and the
// jobs that came of it. The third thing the window is for, beside mail and
// the calendar, and reached the same way — from the rail's foot or a key.
//
// The agent does its own reading through himalaya, so nothing here shows
// mail: it shows what was asked, what the agent is doing, and what it wrote.
Item {
  id: root

  required property var service
  required property color textColor
  required property color backgroundColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property string panelFontFamily

  property bool everyAccount: false
  // The job whose output is open. The newest until one is chosen.
  property string chosenId: ""

  // Every job, the message ones included: this is where the agent's whole
  // history lives, and a message job's output is only readable here.
  readonly property var jobs: service ? service.agentPaneJobs : []
  readonly property string shownId: chosenId !== "" ? chosenId
    : (jobs.length > 0 ? String(jobs[0].id) : "")
  readonly property var shownJob: {
    for (var i = 0; i < jobs.length; i++) if (String(jobs[i].id) === shownId) return jobs[i]
    return null
  }
  readonly property bool hasAgent: !!service && service.hasAgent

  function takeFocus() { promptField.forceActiveFocus() }

  function submit() {
    var prompt = String(promptField.text || "").trim()
    if (prompt === "" || !service || !hasAgent) return
    if (!service.askAgentScope(prompt, everyAccount)) return
    promptField.text = ""
    chosenId = ""
  }

  // Reading follows the shown job: the runner is asked for its output when
  // it changes, and again on every poll while it runs.
  onShownIdChanged: if (service && shownId !== "") service.showAgentJob(shownId)
  Component.onCompleted: if (service && shownId !== "") service.showAgentJob(shownId)

  Rectangle {
    anchors.fill: parent
    color: root.backgroundColor
  }

  Column {
    id: ask
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: Style.space(16)
    spacing: Style.space(8)

    Text {
      text: "Agent"
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.heading
      font.bold: true
    }

    Text {
      width: parent.width
      visible: !root.hasAgent
      text: "No agent is set. Name one in Settings — a command that reads a prompt "
        + "on stdin, such as claude -p — and this pane can ask it things."
      color: root.dimColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }

    // Which mailboxes the ask is about: one segmented control, the way the
    // reader chooses its mode.
    Row {
      visible: root.hasAgent
      spacing: 0

      Rectangle {
        width: scopeSegments.implicitWidth
        height: scopeSegments.implicitHeight
        radius: Style.cornerRadius
        color: "transparent"
        border.width: 1
        border.color: Style.normalBorderFor(root.textColor, root.accentColor)

        Row {
          id: scopeSegments
          spacing: 0

          ScopeSegment {
            text: root.service && root.service.accountLabel !== "" ? root.service.accountLabel : "This mailbox"
            active: !root.everyAccount
            first: true
            onChosen: root.everyAccount = false
          }
          ScopeSegment {
            text: "Every mailbox"
            active: root.everyAccount
            onChosen: root.everyAccount = true
          }
        }
      }
    }

    Row {
      width: parent.width
      visible: root.hasAgent
      spacing: Style.space(8)

      TextField {
        id: promptField
        objectName: "agent-pane-prompt"
        width: parent.width - askButton.width - parent.spacing
        foreground: root.textColor
        accent: root.accentColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
        placeholderText: "Find the last message from Ada about the invoice and draft a reply"
        onAccepted: root.submit()
      }

      Button {
        id: askButton
        objectName: "agent-pane-ask"
        anchors.verticalCenter: parent.verticalCenter
        text: "Ask"
        tooltipText: "Start the agent · Return"
        foreground: root.textColor
        bordered: true
        accent: root.accentColor
        fontFamily: root.panelFontFamily
        fontSize: Style.font.caption
        enabled: String(promptField.text || "").trim() !== ""
        onClicked: root.submit()
      }
    }
  }

  PanelSeparator {
    id: rule
    anchors.top: ask.bottom
    anchors.topMargin: Style.space(12)
    width: parent.width
    foreground: root.textColor
  }

  // The jobs, newest first, with the shown one open. A card is the ask and
  // its state; the open one carries the agent's output under it.
  Flickable {
    id: flick
    WheelScroller { view: flick }
    anchors.top: rule.bottom
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    contentWidth: width
    contentHeight: cards.implicitHeight + Style.space(24)
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    Column {
      id: cards
      x: Style.space(16)
      y: Style.space(12)
      width: flick.width - Style.space(32)
      spacing: Style.space(8)

      Text {
        width: parent.width
        visible: root.hasAgent && root.jobs.length === 0
        text: "Nothing asked yet."
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Repeater {
        model: root.jobs

        Rectangle {
          id: card
          required property var modelData
          readonly property bool open: String(modelData.id) === root.shownId
          readonly property string glyph: Agent.glyphState(modelData)
          readonly property bool working: Agent.isActive(modelData)

          width: parent.width
          implicitHeight: cardColumn.implicitHeight + Style.space(20)
          radius: Style.cornerRadius
          color: card.open
            ? Style.selectedFillFor(root.textColor, root.accentColor)
            : (cardHover.hovered ? Style.hoverFillFor(root.textColor, root.accentColor)
              : Style.normalFillFor(root.textColor, root.accentColor))
          border.width: card.open ? Style.normalBorderWidth : 0
          border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

          HoverHandler { id: cardHover }
          TapHandler { onTapped: root.chosenId = String(card.modelData.id) }

          Column {
            id: cardColumn
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.margins: Style.space(10)
            spacing: Style.space(4)

            Row {
              width: parent.width
              spacing: Style.space(8)

              ActionIcon {
                anchors.verticalCenter: parent.verticalCenter
                name: "agent"
                iconSize: Style.font.iconSmall
                color: card.glyph === "failed" ? root.urgentColor
                  : (card.glyph === "question" ? root.urgentColor
                    : (card.working ? root.accentColor : root.dimColor))
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: Agent.stateLabel(card.modelData)
                color: root.textColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Text {
                anchors.verticalCenter: parent.verticalCenter
                // A subject was written by a stranger.
                textFormat: Text.PlainText
                text: "· " + Agent.jobAboutLabel(card.modelData,
                  root.service && card.modelData.scope !== "all" ? root.service.accountLabel : "")
                color: root.dimColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }
            }

            // The ask was typed by the owner; what follows was written by the
            // agent about mail strangers sent. Plain text throughout.
            Text {
              width: parent.width
              textFormat: Text.PlainText
              text: String(card.modelData.prompt || "")
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
              maximumLineCount: card.open ? 20 : 2
              elide: Text.ElideRight
            }

            Text {
              width: parent.width
              visible: !card.open && Agent.detailText(card.modelData) !== ""
              textFormat: Text.PlainText
              text: Agent.detailText(card.modelData)
              color: card.glyph === "failed" ? root.urgentColor : root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }

            Item {
              width: parent.width
              height: Style.space(4)
              visible: card.open
            }

            Text {
              width: parent.width
              visible: card.open
              textFormat: Text.PlainText
              text: {
                if (String(card.modelData.id) !== (root.service ? root.service.agentShownId : ""))
                  return card.working ? "Working" : ""
                var out = root.service ? root.service.agentShownOutput : ""
                if (out === "") return card.working ? "Working" : Agent.detailText(card.modelData)
                return out
              }
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WrapAnywhere
            }

            Row {
              visible: card.open && card.working
              spacing: Style.space(8)

              Button {
                objectName: "agent-pane-cancel"
                text: "Cancel actions"
                tooltipText: "Stop the agent and everything it is doing"
                foreground: root.urgentColor
                bordered: true
                accent: root.urgentColor
                fontFamily: root.panelFontFamily
                fontSize: Style.font.caption
                onClicked: if (root.service) root.service.cancelAgentJob(String(card.modelData.id))
              }
            }
          }
        }
      }
    }
  }

  component ScopeSegment: Rectangle {
    id: segment
    required property string text
    property bool active: false
    property bool first: false
    signal chosen()

    implicitWidth: segmentText.implicitWidth + Style.space(20)
    implicitHeight: Style.spacing.controlHeight
    color: segment.active
      ? Style.selectedFillFor(root.textColor, root.accentColor)
      : (segmentHover.hovered ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")
    radius: Style.cornerRadius

    Text {
      id: segmentText
      anchors.centerIn: parent
      text: segment.text
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.caption
      font.bold: segment.active
    }

    HoverHandler { id: segmentHover }
    TapHandler { onTapped: segment.chosen() }
  }
}
