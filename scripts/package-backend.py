#!/usr/bin/env python3
"""Build and validate the plugin's fixed, single-executable release assets."""
import argparse
import hashlib
import gzip
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tomllib

ARCHES = ('x86_64', 'aarch64')


def check(root, tag=None, require_pin=False):
    version = tomllib.loads((root / 'Cargo.toml').read_text())['package']['version']
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('expected canonical MAJOR.MINOR.PATCH')
    versions = {}
    packages = tomllib.loads((root / 'Cargo.lock').read_text())['package']
    versions['lock'] = next(p['version'] for p in packages if p['name'] == 'omamail')
    if require_pin:
        versions['backend-version'] = (root / 'backend-version').read_text().removesuffix('\n')
    if tag is not None:
        versions['tag'] = tag.removeprefix('v') if tag.startswith('v') else ''
    if any(value != version for value in versions.values()):
        raise ValueError(f'versions disagree with Cargo {version}: {versions}')
    return version


PROVENANCE_LIMIT = 4 * 1024 * 1024


def provenance(root):
    """Fingerprint source inputs, independent of checkout paths and mtimes.

    Include non-Rust resources under src and literal include macro dependencies
    outside it. Dynamic include expressions fail closed: add explicit support
    before using them, rather than publishing an incomplete fingerprint.
    """
    root = root.resolve()
    version = check(root)
    # This is a reviewed input inventory, not a Cargo build sandbox. A build
    # script can read arbitrary files and environment values; new build scripts,
    # compiler flags or workflow/toolchain changes require build-config review.
    manifest = tomllib.loads((root / 'Cargo.toml').read_text())
    if 'workspace' in manifest or 'workspace' in manifest.get('package', {}):
        raise ValueError('workspace inputs require explicit provenance support')

    def reject_local_dependencies(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == 'path':
                    raise ValueError('Cargo path dependencies require explicit provenance support')
                reject_local_dependencies(child)
        elif isinstance(value, list):
            for child in value:
                reject_local_dependencies(child)

    for key in ('dependencies', 'dev-dependencies', 'build-dependencies', 'target', 'patch', 'replace'):
        reject_local_dependencies(manifest.get(key, {}))
    for kind in ('lib', 'bin', 'example', 'test', 'bench'):
        targets = manifest.get(kind, [])
        if isinstance(targets, dict):
            targets = [targets]
        for target in targets:
            if 'path' in target:
                resolved = Path(os.path.abspath(root / target['path']))
                if not resolved.is_relative_to(root / 'src'):
                    raise ValueError('Cargo target paths outside src require explicit provenance support')
    build = manifest.get('package', {}).get('build')
    if build not in (None, False, True, 'build.rs'):
        raise ValueError('custom build script paths require explicit provenance support')
    paths = set()

    def add(path):
        relative = path.relative_to(root)
        if any(part in ('.', '..') for part in relative.parts):
            raise ValueError('noncanonical source path')
        current = root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError('source inputs must not be symlinks')
        if not path.is_file():
            raise ValueError('missing source input: ' + relative.as_posix())
        paths.add(path)
        if len(paths) > 10000:
            raise ValueError('too many source inputs')

    def add_reference(parent, name):
        target = parent / name
        current = Path(target.anchor)
        for part in target.parts[1:]:
            current = current / part
            if current.is_symlink():
                raise ValueError('source inputs must not be symlinks')
        add(Path(os.path.abspath(target)))

    if not (root / 'src').is_dir() or (root / 'src').is_symlink():
        raise ValueError('missing or unsafe src directory')
    for path in (root / 'src').rglob('*'):
        if path.is_symlink():
            raise ValueError('source inputs must not be symlinks')
        if path.is_file():
            add(path)
    for name in ('Cargo.toml', 'Cargo.lock', 'build.rs', 'rust-toolchain',
                 'rust-toolchain.toml', '.cargo/config', '.cargo/config.toml'):
        path = root / name
        if path.exists() or path.is_symlink():
            add(path)
    visited = set()
    while True:
        pending = sorted(path for path in paths - visited if path.suffix == '.rs')
        if not pending:
            break
        for path in pending:
            visited.add(path)
            source = path.read_text(encoding='utf-8')
            if not path.is_relative_to(root / 'src') and re.search(r'\bmod\s+\w+\s*;', source):
                raise ValueError('implicit modules outside src require explicit provenance support')
            if re.search(r'#\s*\[\s*cfg_attr\b[^\]]*\bpath\s*=', source):
                raise ValueError('conditional module paths require explicit provenance support')
            for match in re.finditer(r'#\s*\[\s*path\s*=', source):
                literal = re.match(r'\s*"([^"\\]*)"\s*\]', source[match.end():])
                if not literal:
                    raise ValueError('module path requires a literal source path')
                add_reference(path.parent, literal[1])
            for match in re.finditer(r'\binclude(?:_str|_bytes)?\s*!\s*\(', source):
                literal = re.match(r'\s*"([^"\\]*)"\s*\)', source[match.end():])
                if not literal:
                    raise ValueError('include macro requires a literal source path')
                add_reference(path.parent, literal[1])
    files = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(paths)}
    canonical = json.dumps(files, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
    return {'schemaVersion': 1, 'backendVersion': version,
            'sourceSha256': hashlib.sha256(canonical).hexdigest(), 'sourceFiles': files}


def check_provenance(root, manifest):
    if manifest.is_symlink() or not manifest.is_file():
        raise ValueError('build provenance must be a regular file')
    with manifest.open('rb') as stream:
        raw = stream.read(PROVENANCE_LIMIT + 1)
    if len(raw) > PROVENANCE_LIMIT:
        raise ValueError('build provenance exceeds size limit')

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate build provenance field')
            result[key] = value
        return result

    try:
        saved = json.loads(raw, object_pairs_hook=unique)
    except (UnicodeError, RecursionError) as error:
        raise ValueError('malformed build provenance') from error
    expected = provenance(root)
    if (not isinstance(saved, dict) or type(saved.get('schemaVersion')) is not int
            or saved != expected):
        raise ValueError('published backend build inputs do not match this checkout; publish a new backend version')


def package(binary, arch, output):
    if binary.is_symlink() or not binary.is_file() or binary.stat().st_size == 0:
        raise ValueError('binary must be a nonempty regular file')
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f'omamail-linux-{arch}.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar:
        info = tarfile.TarInfo('omamail')
        info.size = binary.stat().st_size
        info.mode = 0o755
        with binary.open('rb') as source:
            tar.addfile(info, source)
    (output / 'SHA256SUMS').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')


def verify(directory, arches):
    hashes = {}
    for line in (directory / 'SHA256SUMS').read_text().splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  (omamail-linux-(?:x86_64|aarch64)\.tar\.gz)', line)
        if not match or match[2] in hashes:
            raise ValueError('invalid or duplicate checksum record')
        hashes[match[2]] = match[1]
    expected = {f'omamail-linux-{arch}.tar.gz' for arch in arches}
    if set(hashes) != expected:
        raise ValueError('checksum asset set does not match requested architectures')
    for name in expected:
        archive = directory / name
        if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > 128 * 1024 * 1024:
            raise ValueError('missing or oversized archive')
        if hashlib.sha256(archive.read_bytes()).hexdigest() != hashes[name]:
            raise ValueError('archive checksum mismatch')
        # Match the installer's physical-header contract. Logical iteration hides
        # GNU/PAX records and ignores trailing nonzero data or truncated padding.
        binary_limit = 256 * 1024 * 1024
        with gzip.open(archive, 'rb') as source:
            unpacked = source.read(binary_limit + 65537)
        if not 512 <= len(unpacked) <= binary_limit + 65536:
            raise ValueError('archive decompression exceeded size limit')
        member = tarfile.TarInfo.frombuf(unpacked[:512], 'utf-8', 'strict')
        if (member.name != 'omamail' or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE)
                or member.linkname or member.mode != 0o755 or not 0 < member.size <= binary_limit):
            raise ValueError('archive must contain only the regular omamail executable')
        end = 512 + member.size
        padded_end = 512 + ((member.size + 511) // 512) * 512
        if len(unpacked) < padded_end + 1024 or len(unpacked) % 512 or any(unpacked[end:]):
            raise ValueError('archive contains extra or truncated data')


def pin(root, branch, expected):
    """Advance a verified release's pin; caller must verify public assets first."""
    def git(*args):
        return subprocess.run(['git', '-C', str(root), *args], check=True,
                              capture_output=True, text=True).stdout.strip()
    version = check(root)
    git('check-ref-format', 'refs/heads/' + branch)
    if not re.fullmatch(r'[0-9a-f]{40,64}', expected) or git('rev-parse', 'HEAD') != expected:
        raise ValueError('checkout is not the expected release revision')
    remote = git('ls-remote', 'origin', 'refs/heads/' + branch).split()
    if remote != [expected, 'refs/heads/' + branch]:
        raise ValueError('release source branch moved; pin was not changed')
    git('diff', '--exit-code')
    git('diff', '--cached', '--exit-code')
    (root / 'backend-version').write_text(version + '\n')
    if not git('diff', '--', 'backend-version'):
        return
    git('add', 'backend-version')
    git('-c', 'user.name=Omamail Release', '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', 'chore: pin published backend ' + version, '--only', 'backend-version')
    git('push', 'origin', 'HEAD:refs/heads/' + branch)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    cmd = sub.add_parser('check')
    cmd.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    cmd.add_argument('--tag')
    cmd.add_argument('--require-pin', action='store_true')
    cmd = sub.add_parser('package')
    cmd.add_argument('binary', type=Path)
    cmd.add_argument('arch', choices=ARCHES)
    cmd.add_argument('output', type=Path)
    cmd = sub.add_parser('verify')
    cmd.add_argument('directory', type=Path)
    cmd.add_argument('--arch', choices=ARCHES, action='append')
    cmd = sub.add_parser('provenance')
    cmd.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    cmd.add_argument('--output', type=Path, default=Path('backend-build.json'))
    cmd = sub.add_parser('check-provenance')
    cmd.add_argument('manifest', type=Path)
    cmd.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    cmd = sub.add_parser('pin')
    cmd.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    cmd.add_argument('--branch', required=True)
    cmd.add_argument('--expected', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'check':
            print(check(args.root, args.tag, args.require_pin))
        elif args.command == 'package':
            package(args.binary, args.arch, args.output)
        elif args.command == 'verify':
            verify(args.directory, args.arch or ARCHES)
        elif args.command == 'provenance':
            args.output.write_text(json.dumps(provenance(args.root), indent=2, sort_keys=True) + '\n')
        elif args.command == 'check-provenance':
            check_provenance(args.root, args.manifest)
        else:
            pin(args.root, args.branch, args.expected)
    except (ValueError, OSError, KeyError, StopIteration, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'backend release: {error}\n')


if __name__ == '__main__':
    main()
