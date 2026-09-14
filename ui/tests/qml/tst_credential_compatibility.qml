import QtQuick
import QtTest
import "../.." as Omamail
import "../../providers" as Providers
import "BackendFixture.js" as BackendFixture

Item {
  id: root

  Omamail.Service {
    id: pluginService
    manifest: ({id:"omamail",name:"Omamail",version:"0.10.1"})
  }

  QtObject {
    id: standaloneHost
    property bool standalone: true
    property string backendPath: "/synthetic/omamail"
    property var capabilities: ({agent:false,tray:false,mailto:false,notifications:false})
  }

  Component {
    id: standaloneFactory
    Omamail.Service {
      manifest: ({id:"omamail",name:"Omamail",version:"0.10.1"})
      platform: standaloneHost
    }
  }

  Component {
    id: pluginImapFactory
    Providers.ImapAuth {
      pluginDir: "/synthetic"
      platform: pluginService
      accountId: "imap:one@example.org"
      settings: ({imapHost:"imap.example.org",imapPort:993,smtpHost:"smtp.example.org",
        smtpPort:465,username:"one@example.org",aliases:[],insecure:false})
    }
  }

  TestCase {
    name: "CredentialCompatibility"

    function processNamed(owner, name) {
      var process = findChild(owner, name)
      verify(process, "missing " + name)
      return process
    }

    function test_pinned_api_three_plugin_uses_the_fixed_keyring_adapter() {
      BackendFixture.markReady(pluginService, 3)
      compare(pluginService.backendCanStoreCredentials, false)
      compare(pluginService.legacyCredentialCompatibility, true)
      compare(pluginService.canAccessCredentials, true)
      var auth = createTemporaryObject(pluginImapFactory, root)
      verify(auth)
      verify(auth.signIn("ordinary secret"), "API 3 plugin sign-in stays available")

      var read = ""
      verify(pluginService.credentialGet("imap-password", "imap:one@example.org", "",
        function(value, error) { read = value + "|" + error }))
      var lookup = processNamed(pluginService, "legacy-credential-get")
      compare(lookup.command, ["secret-tool", "lookup", "service", "omamail", "kind",
        "imap-password", "account", "imap:one@example.org"])
      lookup.stdout.text = "quotes '\" and Unicode 你好\n"
      lookup.exited(0)
      compare(read, "quotes '\" and Unicode 你好|")

      var stored = false
      verify(pluginService.credentialPut("calendar-password", "source-one", "", "$(not shell)",
        function(ok) { stored = ok }))
      var writer = processNamed(pluginService, "legacy-credential-put")
      compare(writer.command, [pluginService.pluginDir + "/scripts/keyring-store.sh",
        "service", "omamail", "kind", "calendar-password", "source", "source-one"])
      verify(writer.command.indexOf("$(not shell)") < 0)
      writer.started()
      compare(writer.written, "$(not shell)\n")
      writer.exited(0)
      compare(stored, true)
    }

    function test_plugin_fallback_rejects_controls_before_process_creation() {
      BackendFixture.markReady(pluginService, 3)
      var called = ""
      verify(!pluginService.credentialPut("imap-password", "imap:one@example.org\n", "",
        "secret", function(ok, error) { called = ok + "|" + error }))
      compare(called, "false|invalid_params")
      compare(findChild(pluginService, "legacy-credential-put"), null)
      verify(!pluginService.credentialPut("imap-password", "imap:one@example.org", "",
        "line one\nline two", function(ok, error) { called = ok + "|" + error }))
      compare(called, "false|invalid_params")
      compare(findChild(pluginService, "legacy-credential-put"), null)
    }

    function test_api_four_uses_typed_rpc_without_a_keyring_process() {
      var listener = BackendFixture.markReady(pluginService, 4)
      listener.answers["credentials.get"] = ({found:true,secret:"native secret"})
      var answer = ""
      verify(pluginService.credentialGet("jmap-secret", "jmap:one@example.org", "",
        function(value, error) { answer = value + "|" + error }))
      tryVerify(function() { return answer !== "" })
      compare(answer, "native secret|")
      var found = null
      for (var i = 0; i < listener.requests.length; i++)
        if (listener.requests[i].method === "credentials.get") found = listener.requests[i]
      verify(found)
      compare(found.params, {kind:"jmap-secret",accountId:"jmap:one@example.org"})
      compare(findChild(pluginService, "legacy-credential-get"), null)
    }

    function test_api_three_standalone_refuses_the_plugin_compatibility_process() {
      var service = createTemporaryObject(standaloneFactory, root)
      verify(service)
      BackendFixture.markReady(service, 3)
      compare(service.legacyCredentialCompatibility, false)
      compare(service.canAccessCredentials, false)
      var answer = ""
      verify(!service.credentialGet("imap-password", "imap:one@example.org", "",
        function(value, error) { answer = value + "|" + error }))
      compare(answer, "|backend_needs_update")
      compare(findChild(service, "legacy-credential-get"), null)
      wait(10)
    }
  }
}
