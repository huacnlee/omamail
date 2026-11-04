import QtQuick

// Which setup page a mailbox kind opens: an entry in the map and its page
// below. The window composes this one object rather than a page per provider,
// so a new kind is added here and the window file does not grow. An Item so
// the pages can be declared as plain children; it draws nothing.
Item {
  id: root
  width: 0
  height: 0
  visible: false

  required property var service
  required property color textColor
  required property color dimColor
  required property color dangerColor
  required property color accentColor
  required property string panelFontFamily

  signal chosen(string providerId)
  signal removeRequested()

  // Gmail is the default for a kind this map does not name.
  readonly property var pages: ({
    imap: imapSetupPage,
    jmap: jmapSetupPage,
    outlook: outlookSetupPage,
    m365: m365SetupPage,
    hey: heySetupPage
  })

  function pageFor(kind, picker) {
    if (picker) return providerPickerPage
    return pages.hasOwnProperty(kind) ? pages[kind] : gmailSetupPage
  }

  Component {
    id: providerPickerPage

    ProviderPicker {
      textColor: root.textColor
      dimColor: root.dimColor
      accentColor: root.accentColor
      panelFontFamily: root.panelFontFamily
      // Back is shown wherever there is something to go back to — which on
      // first run, where the chooser is the root, there is not.
      onChosen: function(providerId) { root.chosen(providerId) }
    }
  }

  Component {
    id: gmailSetupPage

    SetupPage {
      service: root.service
      textColor: root.textColor
      dimColor: root.dimColor
      dangerColor: root.dangerColor
      accentColor: root.accentColor
      panelFontFamily: root.panelFontFamily
      accountCount: root.service ? root.service.accountCount : 1
      onRemoveRequested: root.removeRequested()
    }
  }

  Component {
    id: heySetupPage

    HeySetupPage {
      service: root.service
      textColor: root.textColor
      dimColor: root.dimColor
      dangerColor: root.dangerColor
      accentColor: root.accentColor
      panelFontFamily: root.panelFontFamily
      accountCount: root.service ? root.service.accountCount : 1
      onRemoveRequested: root.removeRequested()
    }
  }

  Component {
    id: outlookSetupPage

    OutlookSetupPage {
      service: root.service
      textColor: root.textColor
      dimColor: root.dimColor
      dangerColor: root.dangerColor
      accentColor: root.accentColor
      panelFontFamily: root.panelFontFamily
      accountCount: root.service ? root.service.accountCount : 1
      onRemoveRequested: root.removeRequested()
    }
  }

  Component {
    id: m365SetupPage

    M365SetupPage {
      service: root.service
      textColor: root.textColor
      dimColor: root.dimColor
      dangerColor: root.dangerColor
      accentColor: root.accentColor
      panelFontFamily: root.panelFontFamily
      onRemoveRequested: root.removeRequested()
    }
  }

  Component {
    id: jmapSetupPage

    JmapSetupPage {
      service: root.service
      textColor: root.textColor
      dimColor: root.dimColor
      dangerColor: root.dangerColor
      accentColor: root.accentColor
      panelFontFamily: root.panelFontFamily
      accountCount: root.service ? root.service.accountCount : 1
      onRemoveRequested: root.removeRequested()
    }
  }

  Component {
    id: imapSetupPage

    ImapSetupPage {
      service: root.service
      textColor: root.textColor
      dimColor: root.dimColor
      dangerColor: root.dangerColor
      accentColor: root.accentColor
      panelFontFamily: root.panelFontFamily
      accountCount: root.service ? root.service.accountCount : 1
      onRemoveRequested: root.removeRequested()
    }
  }
}
