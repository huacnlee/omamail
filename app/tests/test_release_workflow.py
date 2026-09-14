#!/usr/bin/env python3
"""Contract for the one-publisher desktop and plugin release workflow."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/release.yml"
CI_WORKFLOW = ROOT / ".github/workflows/ci.yml"
PUBLISH = ROOT / "scripts/publish-backend.sh"

APP_JOBS = {
    "app-macos-aarch64": ("macos-15", "omamail-app-macos-aarch64.tar.gz"),
    "app-linux-x86_64": ("ubuntu-22.04", "omamail-app-linux-x86_64.tar.gz"),
    "app-windows-x86_64": ("windows-2022", "omamail-app-windows-x86_64.zip"),
}

CI_APP_JOBS = {
    "standalone-app-macos": ("macos-15", "macos-aarch64", "omamail-app-macos-aarch64.tar.gz"),
    "standalone-app-linux": ("ubuntu-22.04", "linux-x86_64", "omamail-app-linux-x86_64.tar.gz"),
    "standalone-app-windows": ("windows-2022", "windows-x86_64", "omamail-app-windows-x86_64.zip"),
}


def job_block(source, name):
    match = re.search(rf"(?ms)^  {re.escape(name)}:\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)", source)
    if not match:
        raise AssertionError(f"missing workflow job {name}")
    return match.group(1)


class ReleaseWorkflowContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text()
        cls.ci_workflow = CI_WORKFLOW.read_text()
        cls.publish = PUBLISH.read_text()

    def test_native_jobs_use_fixed_runners_and_publish_exact_assets(self):
        for job, (runner, asset) in APP_JOBS.items():
            with self.subTest(job=job):
                block = job_block(self.workflow, job)
                self.assertIn(f"runs-on: {runner}", block)
                self.assertIn(asset, block)
                self.assertIn("if-no-files-found: error", block)
                self.assertIn('version: "6.8.3"', block)
                self.assertIn('cmake==3.31.6', block)
                self.assertIn('ninja==1.11.1.4', block)

    def test_release_dependencies_and_build_tools_are_immutable(self):
        uses = re.findall(r"(?m)^\s*- uses:\s*([^\s#]+)", self.workflow)
        self.assertTrue(uses)
        for action in uses:
            with self.subTest(action=action):
                self.assertRegex(action, r"^[^@]+@[0-9a-f]{40}$")
        self.assertIn('toolchain: "1.98.1"', self.workflow)
        self.assertIn('node-version: "20.20.2"', self.workflow)
        self.assertIn('aqtversion: "==3.3.0"', self.workflow)
        self.assertIn('py7zrversion: "==1.0.0"', self.workflow)
        self.assertNotIn("brew install", self.workflow)

    def test_each_native_job_runs_backend_qt_qml_package_installer_and_live_smoke_gates(self):
        required = (
            "--no-default-features --features standalone",
            "credentials_native",
            "cmake -S app",
            "ctest --test-dir",
            "-input app/tests/qml/tst_host_contract.qml",
            "test_qml_inventory.py",
            "test_backend_api.py",
            "--check-resources",
            "--smoke-test",
        )
        for job in APP_JOBS:
            with self.subTest(job=job):
                block = job_block(self.workflow, job)
                for needle in required:
                    self.assertIn(needle, block)
                self.assertIn("QT_QUICK_CONTROLS_STYLE: Omamail", block)
                self.assertIn("QT_QUICK_CONTROLS_FALLBACK_STYLE: Basic", block)
                self.assertIn("-import app/qml/styles", block)
                if "windows" in job:
                    self.assertEqual(block.count("QT_QPA_PLATFORM: offscreen"), 1)
                    self.assertEqual(block.count("QT_QPA_PLATFORM: windows"), 1)
                    self.assertNotRegex(block, r"(?i)\$host\s*=")
                    self.assertIn("& $appExecutable --smoke-test", block)
                    self.assertIn("Test-Package.ps1", block)
                    self.assertIn("Test-Install.ps1", block)
                    self.assertIn("package-release.ps1", block)
                    self.assertIn('-G "Visual Studio 17 2022" -A x64', block)
                    self.assertIn("cmake --build build/app --config Release", block)
                    self.assertIn("ctest --test-dir build/app -C Release", block)
                    self.assertIn("-HostBinary build/app/Release/omamail-app.exe", block)
                elif "macos" in job:
                    self.assertEqual(block.count("QT_QPA_PLATFORM: offscreen"), 1)
                    self.assertEqual(block.count("QT_QPA_PLATFORM: cocoa"), 1)
                else:
                    self.assertIn("test_package.py", block)
                    self.assertIn("test_install.sh", block)
                    self.assertIn("package-release.sh", block)
                    self.assertIn('--host "$PWD/build/app/omamail-app"', block)

    def test_pull_requests_build_and_exercise_each_production_standalone_archive(self):
        forbidden = ("gh release create", "gh release edit", "publish-backend.sh")
        for job, (runner, target, archive) in CI_APP_JOBS.items():
            with self.subTest(job=job):
                block = job_block(self.ci_workflow, job)
                self.assertIn(f"runs-on: {runner}", block)
                self.assertIn("--no-default-features --features standalone", block)
                self.assertIn("cmake -S app", block)
                self.assertIn("ctest --test-dir", block)
                self.assertIn("-input app/tests/qml/tst_host_contract.qml", block)
                self.assertIn("QT_QUICK_CONTROLS_STYLE: Omamail", block)
                self.assertIn("QT_QUICK_CONTROLS_FALLBACK_STYLE: Basic", block)
                self.assertIn("-import app/qml/styles", block)
                self.assertIn("test_backend_api.py", block)
                self.assertIn("--standalone", block)
                self.assertIn("--check-resources", block)
                self.assertIn("--smoke-test", block)
                self.assertIn(archive, block)
                if target == "windows-x86_64":
                    self.assertEqual(block.count("QT_QPA_PLATFORM: offscreen"), 1)
                    self.assertEqual(block.count("QT_QPA_PLATFORM: windows"), 1)
                    self.assertIn("package-release.ps1", block)
                    self.assertNotRegex(block, r"(?i)\$host\s*=")
                    self.assertIn("& $appExecutable --smoke-test", block)
                    self.assertIn("Test-Package.ps1", block)
                    self.assertIn("Test-Install.ps1", block)
                    self.assertIn('-G "Visual Studio 17 2022" -A x64', block)
                    self.assertIn("cmake --build build/app --config Release", block)
                    self.assertIn("ctest --test-dir build/app -C Release", block)
                    self.assertIn("-HostBinary build/app/Release/omamail-app.exe", block)
                elif target == "macos-aarch64":
                    self.assertEqual(block.count("QT_QPA_PLATFORM: offscreen"), 1)
                    self.assertEqual(block.count("QT_QPA_PLATFORM: cocoa"), 1)
                else:
                    self.assertIn(f"package-release.sh {target}", block)
                    self.assertIn("test_package.py", block)
                    self.assertIn("test_install.sh", block)
                for command in forbidden:
                    self.assertNotIn(command, block)

    def test_every_build_is_required_before_the_only_publisher_can_pin(self):
        publish = job_block(self.workflow, "publish-and-pin")
        for dependency in ("prepare", "build", *APP_JOBS):
            self.assertRegex(publish, rf"needs:\s*\[[^\]]*\b{re.escape(dependency)}\b")
        self.assertEqual(self.workflow.count("scripts/publish-backend.sh"), 1)
        self.assertEqual((self.workflow + self.publish).count("gh release create"), 1)
        self.assertEqual((self.workflow + self.publish).count("package-backend.py release-checksums"), 1)

    def test_publisher_collects_both_asset_families_installers_contract_and_one_checksum(self):
        expected = {
            "omamail-linux-x86_64.tar.gz",
            "omamail-linux-aarch64.tar.gz",
            "omamail-app-macos-aarch64.tar.gz",
            "omamail-app-linux-x86_64.tar.gz",
            "omamail-app-windows-x86_64.zip",
            "install.sh",
            "install.ps1",
            "SHA256SUMS",
            "backend-api.json",
        }
        for name in expected:
            self.assertIn(name, self.publish)
        self.assertIn("package-backend.py verify-release", self.publish)
        self.assertIn("package-backend.py check-provenance", self.publish)
        self.assertIn("package-backend.py pin", self.publish)

    def test_release_one_has_no_native_host_reuse_or_fast_path(self):
        release_sources = (self.workflow + "\n" + self.publish).lower()
        for forbidden in ("reuse_host", "reuse-host", "reuse_archive", "reuse-archive", "fast-path"):
            self.assertNotIn(forbidden, release_sources)

    def test_prepare_and_publish_require_one_canonical_version(self):
        prepare = job_block(self.workflow, "prepare")
        self.assertIn("package-backend.py check", prepare)
        self.assertIn('check --tag "v$VERSION"', self.publish)

    def test_release_branch_is_the_only_trigger_and_creates_one_exact_tag(self):
        trigger = self.workflow.split("permissions:", 1)[0]
        self.assertRegex(trigger, r"(?ms)^\s*push:\n\s*branches:\s*\['release/\*\*'\]")
        self.assertNotIn("tags:", trigger)
        self.assertEqual(self.publish.count('git tag "v$VERSION" "$GITHUB_SHA"'), 1)
        self.assertEqual(self.publish.count('git push origin "refs/tags/v$VERSION"'), 1)

    def test_standalone_contract_excludes_disabled_agent_api(self):
        for job in APP_JOBS:
            with self.subTest(job=job):
                block = job_block(self.workflow, job)
                commands = [line for line in block.splitlines() if "tests/test_backend_api.py" in line]
                self.assertGreaterEqual(len(commands), 2)
                self.assertTrue(all("--standalone" in line for line in commands))

    def test_draft_and_public_downloads_are_both_verified_before_pin(self):
        draft_download = self.publish.index('gh release download "v$VERSION" --dir draft-download')
        publication = self.publish.index('gh release edit "v$VERSION" --draft=false')
        public_download = self.publish.index('gh release download "v$VERSION" --dir public-download')
        pin = self.publish.index('package-backend.py pin --branch')
        self.assertLess(draft_download, publication)
        self.assertLess(publication, public_download)
        self.assertLess(public_download, pin)
        self.assertGreaterEqual(self.publish.count("package-backend.py verify-release"), 2)

    def test_contract_itself_is_a_pull_request_and_release_gate(self):
        command = "python3 app/tests/test_release_workflow.py"
        self.assertIn(command, self.workflow)
        self.assertIn(command, self.ci_workflow)


if __name__ == "__main__":
    unittest.main()
