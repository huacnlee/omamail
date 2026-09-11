import QtQuick 2.15
import QtTest 1.3

Item {
  width: 500
  height: 100

  Loader {
    id: attachmentLoader
    anchors.left: parent.left
    anchors.right: parent.right
    Component.onCompleted: setSource("../../components/AttachmentRow.qml", ({
      textColor: Qt.rgba(1, 1, 1, 1),
      dimColor: Qt.rgba(0.67, 0.67, 0.67, 1),
      dimmerColor: Qt.rgba(0.47, 0.47, 0.47, 1),
      panelFontFamily: "monospace"
    }))
    onLoaded: {
      item.attachment = ({
        filename: "Quarterly report.pdf",
        mimeType: "application/pdf",
        size: 1536,
        attachmentId: "att-7"
      })
    }
  }

  SignalSpy {
    id: openSpy
    target: attachmentLoader.item
    signalName: "openRequested"
  }

  TestCase {
    name: "AttachmentRow"
    when: windowShown

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function test_filename_opens_the_listed_attachment() {
      tryCompare(attachmentLoader, "status", Loader.Ready)
      var link = named(attachmentLoader.item, "attachment-open-link")
      verify(link, "the attachment filename must be an identifiable control")

      openSpy.clear()
      mouseClick(link, link.width / 2, link.height / 2)
      compare(openSpy.count, 1)
      compare(openSpy.signalArguments[0][0].attachmentId, "att-7")
    }
  }
}
