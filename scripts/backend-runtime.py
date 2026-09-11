#!/usr/bin/env python3
"""Manage the plugin's exact-version private backend, only on explicit request."""
import contextlib
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import selectors
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
BINARY = ROOT / "runtime/bin/omamail"
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
ARCHIVE_LIMIT = 128 * 1024 * 1024
BINARY_LIMIT = 256 * 1024 * 1024


class Refused(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def pin():
    with (ROOT / "backend-version").open("rb") as source:
        raw = source.read(258)
    text = raw.decode("ascii")
    version = text[:-1] if text.endswith("\n") else text
    require(len(raw) <= 256 and VERSION.fullmatch(version), "Invalid backend version pin.")
    return version


def api_pin():
    with (ROOT / "backend-api.json").open("rb") as source:
        raw = source.read(1024 * 1024 + 1)
    require(len(raw) <= 1024 * 1024, "Backend API contract is too large.")
    version = json.loads(raw).get("apiVersion")
    require(type(version) is int and 0 < version <= 2147483647, "Invalid backend API version.")
    return version


def safe_path(path, directory=False, create=False):
    """Refuse symlink components, including dangling links; never chmod existing paths."""
    for part in [*reversed(path.parents), path]:
        if part == Path(part.anchor):
            continue
        try:
            mode = part.lstat().st_mode
        except FileNotFoundError:
            if create:
                part.mkdir(mode=0o700)
                mode = part.lstat().st_mode
            else:
                continue
        require(not stat.S_ISLNK(mode), "Refusing a symbolic link in the runtime path.")
        if part != path or directory:
            require(stat.S_ISDIR(mode), "Runtime directory is not a directory.")
        else:
            require(stat.S_ISREG(mode), "Runtime executable is not a regular file.")


def version_of(executable):
    """Bound both the probe's time and its output; never surface child diagnostics."""
    if not executable.exists():
        return ""
    process = subprocess.Popen([str(executable), "--version"], stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    output = bytearray()
    try:
        deadline = time.monotonic() + 5
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                require(remaining > 0, "Backend version check timed out.")
                require(selector.select(remaining), "Backend version check timed out.")
                chunk = os.read(process.stdout.fileno(), 257)
                if not chunk:
                    break
                output.extend(chunk)
                require(len(output) <= 256, "Invalid backend version response.")
        require(process.wait(timeout=max(0.01, deadline - time.monotonic())) == 0,
                "Backend version check failed.")
        match = re.fullmatch(rb"omamail ([^\r\n ]+)\n?", bytes(output))
        require(match is not None, "Invalid backend version response.")
        version = match[1].decode("ascii")
        require(VERSION.fullmatch(version), "Invalid backend version response.")
        return version
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        process.stdout.close()


def checkout_version():
    """A local build may advance Cargo before a release has advanced the pin."""
    import tomllib
    require((ROOT / ".git").exists(), "Local version overrides require a Git checkout.")
    safe_path(ROOT / "Cargo.toml")
    with (ROOT / "Cargo.toml").open("rb") as source:
        version = tomllib.load(source)["package"]["version"]
    require(isinstance(version, str) and VERSION.fullmatch(version), "Invalid Cargo package version.")
    return version


def local_required(required):
    """Only an explicit installation of these exact bytes overrides the release pin."""
    local_build = ROOT / "runtime/local-build.json"
    safe_path(local_build)
    if not local_build.exists():
        return required
    descriptor = os.open(local_build, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as source:
        metadata = os.fstat(source.fileno())
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid()
                and metadata.st_nlink == 1 and metadata.st_mode & 0o077 == 0,
                "Local build marker must be a private regular file.")
        raw = source.read(1025)
    require(len(raw) <= 1024, "Invalid local build marker.")
    marker = json.loads(raw)
    require(isinstance(marker, dict) and set(marker) == {"version", "releasePin", "sha256"}
            and isinstance(marker["version"], str) and VERSION.fullmatch(marker["version"])
            and isinstance(marker["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", marker["sha256"]),
            "Invalid local build marker.")
    if marker["releasePin"] != required or not (ROOT / ".git").exists() or not BINARY.exists():
        return required
    if checkout_version() != marker["version"]:
        return required
    with BINARY.open("rb") as binary:
        digest = hashlib.sha256()
        size = 0
        while chunk := binary.read(1024 * 1024):
            size += len(chunk)
            require(size <= BINARY_LIMIT, "Local backend exceeded its size limit.")
            digest.update(chunk)
    return marker["version"] if digest.hexdigest() == marker["sha256"] else required


def replace_runtime(candidate, marker=None):
    """Keep the old override if the atomic executable replacement fails."""
    local_build = ROOT / "runtime/local-build.json"
    safe_path(BINARY)
    safe_path(local_build)
    backup = candidate.parent / "previous-local-build.json"
    had_marker = local_build.exists()
    if had_marker:
        os.replace(local_build, backup)
    try:
        if marker is not None:
            os.replace(marker, local_build)
        os.replace(candidate, BINARY)
    except BaseException:
        if had_marker:
            os.replace(backup, local_build)
        else:
            local_build.unlink(missing_ok=True)
        raise


def release_url_allowed(url):
    parsed = urllib.parse.urlsplit(url)
    return (parsed.scheme == "https" and parsed.hostname in
            ("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com")
            and parsed.port in (None, 443) and not parsed.username and not parsed.password
            and not any(ord(character) < 33 or ord(character) == 127 for character in url))


class ReleaseRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        require(release_url_allowed(newurl), "Release redirect was refused.")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def download(url, limit):
    require(release_url_allowed(url), "Release URL was refused.")
    # Ignore proxy environment variables; redirects remain fixed HTTPS release hosts.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), ReleaseRedirect())
    with opener.open(url, timeout=20) as response:
        require(response.status == 200, "Release download failed.")
        content = response.read(limit + 1)
    require(len(content) <= limit, "Release download exceeded its size limit.")
    return content


@contextlib.contextmanager
def deadline():
    def expired(signum, frame):
        raise Refused("Backend installation timed out.")
    previous = signal.signal(signal.SIGALRM, expired)
    signal.alarm(180)
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


@contextlib.contextmanager
def locked():
    runtime = ROOT / "runtime"
    safe_path(runtime, directory=True, create=True)
    descriptor = os.open(runtime / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(descriptor).st_mode), "Invalid runtime lock.")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("Another backend operation is running.") from None
        yield
    finally:
        os.close(descriptor)


def install(required, architecture):
    safe_path(BINARY)
    safe_path(ROOT / "runtime/local-build.json")
    asset = "omamail-linux-" + architecture + ".tar.gz"
    base = "https://github.com/huacnlee/omamail/releases/download/v" + required + "/"
    with deadline():
        checksums = download(base + "SHA256SUMS", 64 * 1024).decode("ascii")
        entries = []
        for line in checksums.splitlines():
            match = re.fullmatch(r"([0-9a-fA-F]{64}) [ *]([^\s]+)", line)
            require(match is not None, "Invalid release checksums.")
            if match[2] == asset:
                entries.append(match[1].lower())
        require(len(entries) == 1, "Release checksum entry is missing or ambiguous.")
        compressed = download(base + asset, ARCHIVE_LIMIT)
        require(hashlib.sha256(compressed).hexdigest() == entries[0], "Release checksum does not match.")
        safe_path(BINARY.parent, directory=True, create=True)
        with tempfile.TemporaryDirectory(prefix=".install-", dir=BINARY.parent) as staging:
            candidate = Path(staging) / "omamail"
            # Parse the first physical header: tarfile iteration hides GNU/PAX entries.
            # Bound decompression too, and accept only zero padding after this one file.
            with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as source:
                unpacked = source.read(BINARY_LIMIT + 65537)
            require(512 <= len(unpacked) <= BINARY_LIMIT + 65536,
                    "Release archive exceeded its size limit.")
            entry = tarfile.TarInfo.frombuf(unpacked[:512], "utf-8", "strict")
            require(entry.name == "omamail" and entry.type in (tarfile.REGTYPE, tarfile.AREGTYPE)
                    and not entry.linkname and 0 < entry.size <= BINARY_LIMIT,
                    "Release archive has an unsafe layout.")
            end = 512 + entry.size
            padded_end = 512 + ((entry.size + 511) // 512) * 512
            require(len(unpacked) >= padded_end + 1024 and len(unpacked) % 512 == 0
                    and not any(unpacked[end:]), "Release archive contains extra or truncated data.")
            with candidate.open("xb") as destination:
                destination.write(unpacked[512:end])
                destination.flush()
                os.fsync(destination.fileno())
            candidate.chmod(0o700)
            require(version_of(candidate) == required, "Downloaded backend has the wrong version.")
            require(pin() == required, "Backend version pin changed during installation.")
            replace_runtime(candidate)


def install_local(required):
    """Install an explicitly built checkout binary, without release downloads."""
    source = ROOT / "target/release/omamail"
    safe_path(source)
    require(source.is_file(), "Build the local backend first with make backend.")
    with source.open("rb") as compiled:
        content = compiled.read(BINARY_LIMIT + 1)
    require(0 < len(content) <= BINARY_LIMIT, "Local backend exceeded its size limit.")
    safe_path(BINARY.parent, directory=True, create=True)
    with tempfile.TemporaryDirectory(prefix=".install-", dir=BINARY.parent) as staging:
        candidate = Path(staging) / "omamail"
        with candidate.open("xb") as destination:
            destination.write(content)
            destination.flush()
            os.fsync(destination.fileno())
        candidate.chmod(0o700)
        version = version_of(candidate)
        local = version != required
        require(not local or version == checkout_version(), "Local backend does not match Cargo package version.")
        require(pin() == required, "Backend version pin changed during installation.")
        marker = None
        if local:
            marker = Path(staging) / "local-build.json"
            with marker.open("xb") as destination:
                destination.write(json.dumps(dict(version=version, releasePin=required,
                                                  sha256=hashlib.sha256(content).hexdigest())).encode())
                destination.flush()
                os.fsync(destination.fileno())
            marker.chmod(0o600)
        replace_runtime(candidate, marker)
        return version


def cli_link(enable):
    link = Path.home() / ".local/bin/omamail"
    safe_path(link.parent, directory=True, create=enable)
    if link.is_symlink():
        require(os.readlink(link) == str(BINARY), "CLI path belongs to another installation.")
        if not enable:
            link.unlink()
    elif link.exists():
        raise Refused("CLI path belongs to another installation.")
    elif enable:
        os.symlink(str(BINARY), link)


def cli_installed():
    """Inspect only the owned link; never execute a PATH or foreign target."""
    link = Path.home() / ".local/bin/omamail"
    try:
        safe_path(link.parent, directory=True)
        return link.is_symlink() and os.readlink(link) == str(BINARY)
    except (OSError, Refused):
        return False


def run(command):
    result = dict(state="error", requiredVersion="", requiredApiVersion=0, installedVersion="", executable=str(BINARY), error="", cliInstalled=False)
    try:
        required = pin()
        result["requiredVersion"] = required
        result["requiredApiVersion"] = api_pin()
        development = os.environ.get("OMAMAIL_BIN", "")
        executable = Path(development) if development else BINARY
        result["executable"] = str(executable)
        require(command in ("status", "install", "install-local", "uninstall", "enable-cli", "disable-cli"), "Unknown backend operation.")
        if command != "status":
            require(not development, "Unset OMAMAIL_BIN before managing the installed backend.")
        architecture = {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(platform.machine())
        if not development and (platform.system() != "Linux" or not architecture):
            result["state"] = "unsupported"
            result["error"] = "Backend releases support Linux x86_64 and aarch64."
            return result
        if not development:
            safe_path(BINARY)
            if command in ("status", "enable-cli", "disable-cli"):
                required = local_required(required)
                result["requiredVersion"] = required
        else:
            require(executable.is_absolute(), "OMAMAIL_BIN must be an absolute executable path.")
        if command != "status":
            with locked():
                if command == "install":
                    install(required, architecture)
                elif command == "install-local":
                    required = install_local(required)
                    result["requiredVersion"] = required
                elif command == "uninstall":
                    safe_path(BINARY)
                    local_build = ROOT / "runtime/local-build.json"
                    safe_path(local_build)
                    local_build.unlink(missing_ok=True)
                    BINARY.unlink(missing_ok=True)
                elif command == "enable-cli":
                    require(version_of(BINARY) == required, "Install the required backend before enabling the CLI.")
                    cli_link(True)
                else:
                    cli_link(False)
        # The candidate was verified before the atomic commit. A second execution
        # must not turn a completed replacement into a reported install failure.
        installed = required if command in ("install", "install-local") else version_of(executable)
        result["installedVersion"] = installed
        result["state"] = "missing" if not installed else "ready" if installed == required else "mismatch"
        result["cliInstalled"] = not development and result["state"] == "ready" and cli_installed()
    except Refused as error:
        result["state"] = "error"
        result["error"] = str(error)
    except Exception:
        result["state"] = "error"
        result["error"] = "Backend operation failed. Check the plugin files, permissions and release availability."
    return result


if __name__ == "__main__":
    result = run(sys.argv[1] if len(sys.argv) == 2 else "")
    print(json.dumps(result))
    sys.exit(1 if result["state"] in ("error", "unsupported") else 0)
