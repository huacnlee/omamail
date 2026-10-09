import QtQuick
import QtTest
import "../../account" as Accounts
import "../../backend" as BackendModule

// The composer's From row names an IMAP or Outlook mailbox's own address with
// the entry's sender name, and only on a backend that names agent sends the
// same way (API 7). A server-named mailbox keeps the name its server gave.
Item {
  Component {
    id: backendFactory
    BackendModule.Backend {
      executable: "/synthetic/runtime/bin/omamail"
      expectedVersion: "0.8.2"
      expectedApiVersion: 1
      launchEnabled: false
    }
  }
  Component {
    id: accountFactory
    Accounts.MailAccount {
      pluginDir: "/synthetic/plugin"
      configuredEmail: "ada@example.org"
      senderName: "Ada Lovelace"
      active: false
      windowOpen: false
    }
  }
  TestCase {
    name: "ComposerSenderName"

    function connected(apiVersion) {
      var backend = createTemporaryObject(backendFactory, parent)
      backend.launchEnabled = true
      backend.connected = true
      backend.protocolInfo = ({ apiVersion: apiVersion })
      return backend
    }

    function primary(account) {
      var rows = account.availableSendAsAliases
      for (var i = 0; i < rows.length; i++) if (rows[i].isPrimary) return rows[i]
      return null
    }

    function test_imap_and_outlook_name_the_primary_address_from_api_7() {
      var providers = ["imap", "outlook"]
      for (var i = 0; i < providers.length; i++) {
        var backend = connected(6)
        var account = createTemporaryObject(accountFactory, parent,
          { backend: backend, providerId: providers[i] })
        account.profile = ({ email: "ada@example.org" })
        compare(backend.ready, true)
        compare(primary(account).displayName, "",
          providers[i] + ": API 6 cannot name agent sends, so the composer does not either")
        backend.protocolInfo = ({ apiVersion: 7 })
        compare(primary(account).displayName, "Ada Lovelace", providers[i])
        backend.latestApiVersion = 8
        backend.protocolInfo = ({ apiVersion: 8 })
        compare(primary(account).displayName, "Ada Lovelace", providers[i] + ": a later API keeps it")
        backend.connected = false
        compare(primary(account).displayName, "", providers[i] + ": nothing is promised offline")
      }
    }

    function test_a_server_named_mailbox_keeps_its_own_name() {
      var account = createTemporaryObject(accountFactory, parent,
        { backend: connected(7), providerId: "gmail" })
      account.profile = ({ email: "ada@example.org" })
      compare(account.availableSendAsAliases.length, 1)
      compare(account.availableSendAsAliases[0].displayName, "")
    }
  }
}
