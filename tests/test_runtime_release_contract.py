"""Release archives must be accepted byte-for-byte by the real private installer."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RuntimeReleaseContract(unittest.TestCase):
    def test_generated_release_installs_and_bad_update_preserves_old_binary(self):
        packaging = load("backend_packaging_contract", "package-backend.py")
        runtime = load("backend_install_contract", "backend-runtime.py")
        with tempfile.TemporaryDirectory(prefix="omamail-release-contract-") as directory:
            root = Path(directory).resolve()
            (root / "backend-version").write_text("0.8.2\n")
            (root / "backend-api.json").write_text('{"apiVersion": 1}')
            binary = root / "build/omamail"
            binary.parent.mkdir()
            payload = b"#!/bin/sh\nprintf 'omamail 0.8.2\\n'\n"
            binary.write_bytes(payload)
            binary.chmod(0o700)
            assets = {}
            checksums = []
            for arch in ("x86_64", "aarch64"):
                output = root / arch
                packaging.package(binary, arch, output)
                name = "omamail-linux-" + arch + ".tar.gz"
                assets[name] = (output / name).read_bytes()
                checksums.append((output / "SHA256SUMS").read_bytes())
            assets["SHA256SUMS"] = b"".join(checksums)
            requested = []

            def fetch(url, limit):
                prefix = "https://github.com/huacnlee/omamail/releases/download/v0.8.2/"
                self.assertTrue(url.startswith(prefix), url)
                name = url[len(prefix):]
                requested.append(name)
                result = assets[name]
                self.assertLessEqual(len(result), limit)
                return result

            installed = root / "runtime/bin/omamail"
            with patch.object(runtime, "ROOT", root), patch.object(runtime, "BINARY", installed), \
                    patch.object(runtime.Path, "home", return_value=root / "home"), \
                    patch.object(runtime.platform, "system", return_value="Linux"), \
                    patch.object(runtime.platform, "machine", return_value="x86_64"), \
                    patch.dict(runtime.os.environ, {"OMAMAIL_BIN": ""}), \
                    patch.object(runtime, "download", side_effect=fetch):
                result = runtime.run("install")
                self.assertEqual(result["state"], "ready", result)
                self.assertEqual(installed.read_bytes(), payload)
                self.assertEqual(requested, ["SHA256SUMS", "omamail-linux-x86_64.tar.gz"])
                assets["omamail-linux-x86_64.tar.gz"] += b"corruption"
                result = runtime.run("install")
                self.assertEqual(result["state"], "error", result)
                self.assertEqual(installed.read_bytes(), payload)


if __name__ == "__main__":
    unittest.main()
