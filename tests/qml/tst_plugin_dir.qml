import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

// Where the plugin's scripts are found. A host that hands the service a public
// copy of the manifest strips its private fields, and the service must still
// know its own directory: without it every command is built as "/scripts/..."
// and nothing that shells out can start.
Item {
  Omamail.Service {
    id: withoutManifest
    manifest: null
  }

  // What a shell that strips private fields actually passes: the public
  // manifest, with `id` and `name` but no `__sourceDir`.
  Omamail.Service {
    id: publicManifest
    manifest: ({ id: "omamail", name: "Omamail", version: "0.8.2" })
  }

  // A manifest that still carries the private field, which the directory is
  // deliberately independent of.
  Omamail.Service {
    id: hostSaidWhere
    manifest: ({ id: "omamail", __sourceDir: "/opt/somewhere-else" })
  }

  TestCase {
    name: "PluginDir"

    // The repository root, which is where Service.qml lives and so what the
    // service should work out for itself.
    function root() {
      var url = String(Qt.resolvedUrl("../.."))
      var path = decodeURIComponent(url.substring("file://".length))
      return path.length > 1 && path.charAt(path.length - 1) === "/"
        ? path.substring(0, path.length - 1) : path
    }

    function test_a_service_with_no_manifest_still_knows_its_directory() {
      compare(withoutManifest.pluginDir, root())
    }

    function test_a_manifest_without_the_private_field_falls_back_to_the_file() {
      compare(publicManifest.pluginDir, root(),
        "a host that strips __sourceDir must not leave the scripts unrooted")
    }

    function test_the_directory_is_absolute_and_has_no_trailing_slash() {
      var dir = publicManifest.pluginDir
      compare(dir.charAt(0), "/")
      verify(dir.charAt(dir.length - 1) !== "/", dir)
      verify(dir.indexOf("file://") < 0, dir)
    }

    // The command every script is named against is rooted, rather than the
    // "/scripts/mail-transport.sh" an empty directory produced.
    function test_a_script_command_is_rooted_under_the_plugin() {
      var command = publicManifest.pluginDir + "/scripts/mail-transport.sh"
      compare(command, root() + "/scripts/mail-transport.sh")
      verify(command.indexOf("//scripts") < 0, command)
      verify(command !== "/scripts/mail-transport.sh")
    }

    // The directory is worked out from the file and nothing else. A manifest
    // that still carries `__sourceDir` does not move it, so the plugin behaves
    // the same whether the host keeps the private field, strips it, or passes
    // no manifest at all — which is three different hosts today.
    function test_the_directory_does_not_depend_on_the_manifest() {
      compare(hostSaidWhere.pluginDir, root())
      compare(hostSaidWhere.pluginDir, publicManifest.pluginDir)
      compare(hostSaidWhere.pluginDir, withoutManifest.pluginDir)
    }
  }
}
