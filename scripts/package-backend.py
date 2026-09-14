#!/usr/bin/env python3
"""Build fixed plugin backends and validate the complete Omamail release set."""
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
PLUGIN_ASSETS = tuple(f'omamail-linux-{arch}.tar.gz' for arch in ARCHES)
APP_ASSETS = (
    'omamail-app-macos-aarch64.tar.gz',
    'omamail-app-linux-x86_64.tar.gz',
    # 'omamail-app-windows-x86_64.zip',  # temporarily not released
)
INSTALLER_ASSETS = ('install.sh', 'install.ps1')
HASHED_RELEASE_ASSETS = tuple(sorted(PLUGIN_ASSETS + APP_ASSETS + INSTALLER_ASSETS))
UNHASHED_RELEASE_ASSETS = ('SHA256SUMS', 'backend-api.json', 'backend-build.json')


def check(root, tag=None, require_pin=False):
    version = tomllib.loads((root / 'Cargo.toml').read_text())['package']['version']
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
        raise ValueError('expected canonical MAJOR.MINOR.PATCH')
    versions = {}
    packages = tomllib.loads((root / 'Cargo.lock').read_text())['package']
    versions['lock'] = next(p['version'] for p in packages if p['name'] == 'omamail')
    manifest = json.loads((root / 'manifest.json').read_bytes())
    if not isinstance(manifest, dict) or not isinstance(manifest.get('version'), str):
        raise ValueError('manifest.json requires a string version')
    versions['manifest'] = manifest['version']
    cmake = (root / 'app/CMakeLists.txt').read_text()
    app_versions = re.findall(
        r'^\s*project\s*\(\s*omamail-app\s+VERSION\s+([^\s\)]+)', cmake,
        flags=re.MULTILINE | re.IGNORECASE)
    if len(app_versions) != 1:
        raise ValueError('app/CMakeLists.txt requires one omamail-app project version')
    versions['app'] = app_versions[0]
    if require_pin:
        versions['backend-version'] = (root / 'backend-version').read_text().removesuffix('\n')
    if tag is not None:
        versions['tag'] = tag.removeprefix('v') if tag.startswith('v') else ''
    if any(value != version for value in versions.values()):
        raise ValueError(f'versions disagree with Cargo {version}: {versions}')
    return version


def pin_version(root):
    path = root / 'backend-version'
    if path.is_symlink() or not path.is_file():
        raise ValueError('backend-version must be a regular file')
    with path.open('rb') as stream:
        raw = stream.read(129)
    if len(raw) > 128 or not re.fullmatch(rb'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\n?', raw):
        raise ValueError('backend-version must be canonical MAJOR.MINOR.PATCH')
    return raw.decode('ascii').removesuffix('\n')


def read_api(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('backend API contract must be a regular file')
    with path.open('rb') as stream:
        raw = stream.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError('backend API contract exceeds size limit')

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate API contract field')
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError('non-JSON API contract constant: ' + value)

    try:
        contract = json.loads(raw, object_pairs_hook=unique, parse_constant=invalid_constant)
    except (UnicodeError, RecursionError) as error:
        raise ValueError('malformed backend API contract') from error
    if (not isinstance(contract, dict)
            or set(contract) != {'apiVersion', 'releasedApiVersion', 'protocolVersion', 'methods',
                                 'contractCases', 'unreleased'}):
        raise ValueError('invalid backend API contract fields')
    for key in ('apiVersion', 'releasedApiVersion', 'protocolVersion'):
        if type(contract[key]) is not int or not 1 <= contract[key] <= 2147483647:
            raise ValueError('invalid backend API revision: ' + key)
    # Two states and no history: the API the pinned binary speaks, and at most
    # one step ahead of it that this checkout implements but has not shipped.
    # A third step waits for a release, which is what makes releases batches.
    if contract['apiVersion'] - contract['releasedApiVersion'] not in (0, 1):
        raise ValueError('apiVersion must equal releasedApiVersion or be one step ahead; release first')
    methods = contract['methods']
    if (not isinstance(methods, list) or not methods
            or any(not isinstance(method, str) or not re.fullmatch(r'[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+', method)
                   for method in methods) or len(set(methods)) != len(methods)):
        raise ValueError('invalid or duplicate API methods')
    cases = contract['contractCases']
    if not isinstance(cases, list) or not cases:
        raise ValueError('API contract requires contractCases')
    names = set()
    for case in cases:
        if (not isinstance(case, dict) or not {'name', 'method', 'params'} <= set(case)
                or set(case) - {'name', 'method', 'params', 'errorCode', 'equals', 'types'}
                or not isinstance(case['name'], str) or not case['name'] or case['name'] in names
                or case['method'] not in methods or not isinstance(case['params'], dict)):
            raise ValueError('invalid API contract case')
        names.add(case['name'])
        if 'errorCode' in case:
            if type(case['errorCode']) is not int:
                raise ValueError('invalid API error expectation')
        elif not case.get('equals') and not case.get('types'):
            raise ValueError('API contract case requires an expectation')
        for field in ('equals', 'types'):
            if field in case and not isinstance(case[field], dict):
                raise ValueError('invalid API expectation: ' + field)
        if any(value not in ('null', 'boolean', 'number', 'string', 'array', 'object')
               for value in case.get('types', {}).values()):
            raise ValueError('invalid API expected type')
    unreleased = contract['unreleased']
    if (not isinstance(unreleased, dict) or set(unreleased) != {'methods', 'cases'}
            or any(not isinstance(unreleased[key], list) for key in ('methods', 'cases'))):
        raise ValueError('invalid unreleased API description')
    for key, known in (('methods', set(methods)), ('cases', names)):
        entries = unreleased[key]
        if (any(not isinstance(entry, str) or entry not in known for entry in entries)
                or len(set(entries)) != len(entries)):
            raise ValueError('unreleased API ' + key + ' must name entries of this contract, once each')
    if contract['apiVersion'] == contract['releasedApiVersion'] and (unreleased['methods'] or unreleased['cases']):
        raise ValueError('an unreleased API change requires apiVersion one ahead of releasedApiVersion')
    unreleased_methods = set(unreleased['methods'])
    for case in cases:
        if case['method'] in unreleased_methods and case['name'] not in unreleased['cases']:
            raise ValueError('a case on an unreleased method is itself unreleased: ' + case['name'])
    return contract


def released_view(contract):
    """What the pinned, published binary speaks: the contract less its unreleased step."""
    unreleased = contract.get('unreleased', {'methods': [], 'cases': []})
    methods = [m for m in contract['methods'] if m not in set(unreleased['methods'])]
    cases = [c for c in contract['contractCases'] if c['name'] not in set(unreleased['cases'])]
    return {'apiVersion': contract.get('releasedApiVersion', contract['apiVersion']),
            'protocolVersion': contract['protocolVersion'], 'methods': methods, 'contractCases': cases}


def full_view(contract):
    """Everything a binary built from this contract's checkout speaks."""
    return {'apiVersion': contract['apiVersion'], 'protocolVersion': contract['protocolVersion'],
            'methods': contract['methods'], 'contractCases': contract['contractCases']}


def read_published_api(path):
    """A published contract: this shape, or the shape before the split had a name."""
    if path.is_symlink() or not path.is_file():
        raise ValueError('published backend API contract must be a regular file')
    raw = path.read_bytes()
    try:
        value = json.loads(raw)
    except ValueError as error:
        raise ValueError('malformed published backend API contract') from error
    if isinstance(value, dict) and 'releasedApiVersion' not in value and 'unreleased' not in value:
        value = dict(value, releasedApiVersion=value.get('apiVersion'), unreleased={'methods': [], 'cases': []})
        # Anything the old binary advertised it also speaks; the split is ours.
        rewritten = path.with_name(path.name + '.split')
        rewritten.write_text(json.dumps(value))
        try:
            return read_api(rewritten)
        finally:
            rewritten.unlink()
    return read_api(path)


def check_api(root, published=None, baseline=None):
    contract = read_api(root / 'backend-api.json')
    source = (root / 'src/backend/methods.rs').read_text()
    inventory = re.search(r'pub\s+const\s+ALL\s*:\s*&\[&str\]\s*=\s*&\[(.*?)\];', source, re.S)
    if not inventory:
        raise ValueError('cannot locate public ALL method inventory')
    entries = re.sub(r'//[^\n]*', '', inventory[1])
    # The default plugin exposes agent methods only on its supported Linux
    # runtime, while standalone builds omit them. They remain part of the full
    # source contract and this is the only conditional inventory form reviewed.
    entries = re.sub(
        r'#\s*\[\s*cfg\s*\(\s*all\s*\(\s*feature\s*=\s*"agent"\s*,\s*'
        r'target_os\s*=\s*"linux"\s*\)\s*\)\s*\]', '', entries)
    if re.sub(r'"[a-zA-Z0-9.]+"|[\s,]', '', entries):
        raise ValueError('public method inventory must contain literal method names')
    methods = re.findall(r'"([a-zA-Z0-9.]+)"', entries)
    if len(set(methods)) != len(methods) or set(methods) != set(contract['methods']):
        raise ValueError('public method inventory differs from backend-api.json; update the API contract')
    canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
    if published is not None:
        # The pinned binary must speak exactly what this checkout calls its
        # released API. The unreleased step is checked against a binary built
        # from the checkout instead, so it may stand here unshipped.
        expected = read_published_api(published)
        if canonical(released_view(contract)) != canonical(full_view(expected)):
            raise ValueError('the released API differs from the published backend; release it or pin it')
    if baseline is not None:
        # What the release under preparation would change against the last one.
        previous = read_published_api(baseline)
        if canonical(released_view(contract)) != canonical(full_view(previous)):
            raise ValueError('the released API must equal the pinned release before a new one is prepared')
        if canonical(full_view(contract)) != canonical(full_view(previous)) and contract['apiVersion'] <= previous['apiVersion']:
            raise ValueError('changed API contract requires a newer apiVersion')
    return contract['apiVersion']


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


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read_checksums(directory):
    path = directory / 'SHA256SUMS'
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024:
        raise ValueError('SHA256SUMS must be a bounded regular file')
    raw = path.read_bytes()
    if not raw or not raw.endswith(b'\n') or b'\r' in raw or b'\0' in raw:
        raise ValueError('SHA256SUMS must use canonical LF-terminated records')
    hashes = {}
    for line in raw[:-1].decode('ascii').split('\n'):
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)', line)
        if not match or match[2] not in HASHED_RELEASE_ASSETS or match[2] in hashes:
            raise ValueError('invalid, unknown or duplicate checksum record')
        hashes[match[2]] = match[1]
    return hashes


def verify(directory, arches):
    hashes = read_checksums(directory)
    expected = {f'omamail-linux-{arch}.tar.gz' for arch in arches}
    if not expected <= set(hashes):
        raise ValueError('checksum asset set does not match requested architectures')
    for name in expected:
        archive = directory / name
        if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > 128 * 1024 * 1024:
            raise ValueError('missing or oversized archive')
        if sha256_file(archive) != hashes[name]:
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


def checked_release_files(directory, require_checksum):
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('release asset directory must be a real directory')
    allowed = set(HASHED_RELEASE_ASSETS + UNHASHED_RELEASE_ASSETS)
    entries = {path.name: path for path in directory.iterdir()}
    unknown = set(entries) - allowed
    if unknown:
        raise ValueError('unexpected release asset: ' + sorted(unknown)[0])
    for name in HASHED_RELEASE_ASSETS:
        path = entries.get(name)
        limit = 2 * 1024 * 1024 if name.startswith('install.') else 1024 * 1024 * 1024
        if path is None or path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= limit:
            raise ValueError('missing, unsafe or oversized release asset: ' + name)
    required_metadata = {'backend-api.json', 'backend-build.json'}
    if require_checksum:
        required_metadata.add('SHA256SUMS')
    for name in required_metadata:
        path = entries.get(name)
        if path is None:
            raise ValueError('missing release metadata: ' + name)
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0:
            raise ValueError('unsafe release metadata: ' + name)
    return entries


def release_checksums(directory):
    checked_release_files(directory, require_checksum=False)
    records = ''.join(f'{sha256_file(directory / name)}  {name}\n'
                      for name in HASHED_RELEASE_ASSETS)
    temporary = directory / f'.SHA256SUMS.{os.getpid()}.tmp'
    try:
        with temporary.open('x', encoding='ascii') as stream:
            stream.write(records)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / 'SHA256SUMS')
    finally:
        temporary.unlink(missing_ok=True)


def verify_release(directory):
    checked_release_files(directory, require_checksum=True)
    hashes = read_checksums(directory)
    if set(hashes) != set(HASHED_RELEASE_ASSETS):
        raise ValueError('release checksum does not cover the exact release asset set')
    for name, expected in hashes.items():
        if sha256_file(directory / name) != expected:
            raise ValueError('release asset checksum mismatch: ' + name)


def pin(root, branch, expected):
    """Advance a verified release's pin; caller must verify public assets first."""
    def git(*args):
        return subprocess.run(['git', '-C', str(root), *args], check=True,
                              capture_output=True, text=True).stdout.strip()
    version = check(root)
    if branch != 'release/' + version:
        raise ValueError('pin requires the versioned release branch; never main')
    git('check-ref-format', 'refs/heads/' + branch)
    if not re.fullmatch(r'[0-9a-f]{40,64}', expected) or git('rev-parse', 'HEAD') != expected:
        raise ValueError('checkout is not the expected release revision')
    remote = git('ls-remote', 'origin', 'refs/heads/' + branch).split()
    if remote != [expected, 'refs/heads/' + branch]:
        raise ValueError('release source branch moved; pin was not changed')
    git('diff', '--exit-code')
    git('diff', '--cached', '--exit-code')
    (root / 'backend-version').write_text(version + '\n')
    # The release just published speaks the whole contract: the unreleased step
    # becomes released, and the checks that read this file relax with it.
    contract = read_api(root / 'backend-api.json')
    contract['releasedApiVersion'] = contract['apiVersion']
    contract['unreleased'] = {'methods': [], 'cases': []}
    (root / 'backend-api.json').write_text(json.dumps(contract, indent=2) + '\n')
    if not git('diff', '--', 'backend-version', 'backend-api.json'):
        return
    git('add', 'backend-version', 'backend-api.json')
    git('-c', 'user.name=Omamail Release', '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', 'chore: pin published backend ' + version, '--only', 'backend-version', 'backend-api.json')
    git('push', 'origin', 'HEAD:refs/heads/' + branch)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    cmd = sub.add_parser('check')
    cmd.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    cmd.add_argument('--tag')
    cmd.add_argument('--require-pin', action='store_true')
    cmd = sub.add_parser('pin-version')
    cmd.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    cmd = sub.add_parser('check-api')
    cmd.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    cmd.add_argument('--published', type=Path)
    cmd.add_argument('--baseline', type=Path)
    cmd = sub.add_parser('package')
    cmd.add_argument('binary', type=Path)
    cmd.add_argument('arch', choices=ARCHES)
    cmd.add_argument('output', type=Path)
    cmd = sub.add_parser('verify')
    cmd.add_argument('directory', type=Path)
    cmd.add_argument('--arch', choices=ARCHES, action='append')
    cmd = sub.add_parser('release-checksums')
    cmd.add_argument('directory', type=Path)
    cmd = sub.add_parser('verify-release')
    cmd.add_argument('directory', type=Path)
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
        elif args.command == 'pin-version':
            print(pin_version(args.root))
        elif args.command == 'check-api':
            print(check_api(args.root, args.published, args.baseline))
        elif args.command == 'package':
            package(args.binary, args.arch, args.output)
        elif args.command == 'verify':
            verify(args.directory, args.arch or ARCHES)
        elif args.command == 'release-checksums':
            release_checksums(args.directory)
        elif args.command == 'verify-release':
            verify_release(args.directory)
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
