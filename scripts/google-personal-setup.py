#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["browser-cookie3==0.20.1"]
# ///
"""Create an owner-only Gmail client through the Google Console's HTTP APIs.

Output is a JSON-lines progress protocol; credentials never reach stdout/stderr.
Only Google's cookies from the explicitly selected local profile are loaded.
Cloud Console APIs are undocumented: fail closed when their schema changes.
"""

import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


LIMIT = 2_000_000
PAGE_LIMIT = 8_000_000
GRAPHQL = '/v3/entityServices/OauthEntityService/schemas/OAUTH_GRAPHQL:batchGraphql'
SIGNATURES = {
    'CreateBrandInfo': '2/Dw5FvjddGnbXz7Cf+AjErbKQIFNnr3XSYhR1UzkvRFA=',
    'GetBrandInfo': '2/uVoo4/LNcLHNpWfXhoBwqyQ7Ynn4KxaPNojx0k7ONqU=',
}
BROWSERS = {
    'edge': ('edge', 'microsoft-edge/Default/Cookies'),
    'chrome': ('chrome', 'google-chrome/Default/Cookies'),
    'chromium': ('chromium', 'chromium/Default/Cookies'),
    'brave': ('brave', 'BraveSoftware/Brave-Browser/Default/Cookies'),
    'firefox': ('firefox', None),
}
child = None


class Refused(Exception):
    pass


class GoogleSignInRequired(Refused):
    def __init__(self, destination='account'):
        self.destination = destination
        super().__init__('Complete Google sign-in in the selected browser to continue.')


class ApiRedirectRefused(Refused):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def emit(event, message='', **values):
    print(json.dumps(dict(event=event, message=message, **values)), flush=True)


def preflight():
    """Inspect prerequisites without opening profiles, sessions or the network."""
    missing = []
    if not shutil.which('gcloud'):
        missing.append('Google Cloud CLI')
    if not shutil.which('uv') and importlib.util.find_spec('browser_cookie3') is None:
        missing.append('uv')
    browser = 'edge'
    command = (['omarchy-cmd-default-browser'] if shutil.which('omarchy-cmd-default-browser')
               else ['xdg-settings', 'get', 'default-web-browser'])
    try:
        desktop = subprocess.run(command, capture_output=True, text=True, timeout=5).stdout[:2048].lower()
        for needle, name in [('edge', 'edge'), ('brave', 'brave'), ('chromium', 'chromium'),
                             ('chrome', 'chrome'), ('firefox', 'firefox')]:
            if needle in desktop:
                browser = name
                break
    except (OSError, subprocess.TimeoutExpired):
        pass
    emit('preflight', missingTools=missing, browser=browser)


def install_tools():
    """Runs only in a visible terminal so package/password prompts are usable."""
    require(shutil.which('omarchy'), 'Install Google Cloud CLI and uv with your package manager.')
    for executable, command in [('uv', ['omarchy', 'pkg', 'add', 'uv']),
                                ('gcloud', ['omarchy', 'pkg', 'aur', 'add', 'google-cloud-cli'])]:
        if not shutil.which(executable):
            require(subprocess.run(command, check=False).returncode == 0,
                    'Tool installation did not finish. Retry from Omamail.')
    print('Setup tools are installed. Return to Omamail and choose Check again.', flush=True)
    if sys.stdin.isatty():
        input('Press Enter to close this terminal. ')


def stop_child():
    if child is not None and child.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGKILL)
        child.wait()


def cancelled(signum, frame):
    stop_child()
    raise SystemExit(130)


def gcloud(*args, timeout=180, optional=False):
    global child
    command = ['gcloud', *args, '--quiet', '--format=json']
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True)
    try:
        out, _ = child.communicate(timeout=timeout)
        if optional and child.returncode:
            return None
        require(child.returncode == 0,
                'Google Cloud could not complete this step. Check account permissions, '
                'project quota and network access, then retry. Your progress is saved.')
        require(len(out) <= LIMIT, 'Google Cloud returned an oversized response.')
        return json.loads(out) if out.strip() else None
    except subprocess.TimeoutExpired:
        stop_child()
        raise Refused('Google Cloud timed out. Retry to resume the saved setup.') from None
    finally:
        child = None


def private_dir(path):
    """Walk without symlinks; require an owner-only leaf directory."""
    path = Path(os.path.abspath(path))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(part, 0o700, dir_fd=fd)
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        info = os.fstat(fd)
        require(info.st_uid == os.getuid() and not info.st_mode & 0o077,
                'The setup directory must belong to you and have mode 0700.')
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_private(fd, name):
    try:
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return None
    with os.fdopen(source, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and info.st_uid == os.getuid() and not info.st_mode & 0o077,
                'Existing setup files must be owner-only regular files without links.')
        data = stream.read(LIMIT + 1)
    require(len(data) <= LIMIT, 'The setup file is too large.')
    return data


def write_private(fd, name, value, expected):
    """Atomic writes, no initial overwrite, and refuse concurrent modifications."""
    require(read_private(fd, name) == expected, 'Setup changed in another window. Retry.')
    temp = '.google-setup-' + secrets.token_hex(12)
    try:
        out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                      0o600, dir_fd=fd)
        with os.fdopen(out, 'wb') as stream:
            stream.write(json.dumps(value).encode() + b'\n')
            stream.flush()
            os.fsync(stream.fileno())
        require(read_private(fd, name) == expected, 'Setup changed in another window. Retry.')
        if expected is None:
            os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
        else:
            os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp, dir_fd=fd)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # In particular, never forward SAPISID authorization to another origin.
        raise ApiRedirectRefused('Google redirected an API request. Retry setup or use manual setup.')


class GooglePageRedirect(urllib.request.HTTPRedirectHandler):
    """Allow Google's session handshake only, never signed API redirects."""
    max_redirections = 8

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old = urllib.parse.urlsplit(req.full_url)
        new = urllib.parse.urlsplit(newurl)
        allowed = ('console.cloud.google.com', 'accounts.google.com')
        require(req.get_method() == 'GET' and not req.has_header('Authorization')
                and old.scheme == 'https' and old.hostname in allowed
                and new.scheme == 'https' and new.hostname in allowed
                and new.port in (None, 443) and new.username is None and new.password is None
                and not any(ord(c) <= 32 or ord(c) == 127 for c in newurl),
                'Google redirected outside the permitted sign-in pages. No request was sent there.')
        # A fresh request carries no copied Cookie, Authorization, Origin or
        # API-key headers. The jar supplies only cookies scoped to this host.
        return urllib.request.Request(newurl, headers={'Accept': 'text/html'})


def cookie_database(browser, profile):
    if profile:
        return Path(profile).expanduser().absolute()
    default_path = BROWSERS[browser][1]
    if not default_path:
        if browser == 'firefox':
            import browser_cookie3
            try:
                # Resolve the same default profile the cookie loader uses;
                # constructing the reader does not load its cookies.
                return Path(browser_cookie3.Firefox(domain_name='.google.com').cookie_file)
            except Exception:
                return None
        return None
    config = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
    path = config / default_path
    if not path.exists() and (path.parent / 'Network' / 'Cookies').is_file():
        path = path.parent / 'Network' / 'Cookies'
    return path


def open_google_sign_in(account, browser, profile, destination):
    programs = {
        'edge': ('microsoft-edge-stable', 'microsoft-edge'),
        'chrome': ('google-chrome-stable', 'google-chrome'),
        'chromium': ('chromium',),
        'brave': ('brave', 'brave-browser'),
        'firefox': ('firefox',),
    }
    program = next((shutil.which(name) for name in programs[browser] if shutil.which(name)), None)
    require(program, 'The selected browser is not installed. Choose your installed browser and retry.')
    console_url = 'https://console.cloud.google.com/auth/clients'
    if destination == 'console':
        url = console_url + '?' + urllib.parse.urlencode({'authuser': account})
    else:
        url = 'https://accounts.google.com/ServiceLogin?' + urllib.parse.urlencode({
            'Email': account, 'continue': console_url})
    command = [program]
    database = cookie_database(browser, profile)
    if browser == 'firefox':
        if database:
            command.extend(['--profile', str(database.parent)])
        command.extend(['--new-tab', url])
    else:
        require(database and database.name == 'Cookies',
                'Select this browser profile’s Cookies database before opening sign-in.')
        profile_dir = database.parent.parent if database.parent.name == 'Network' else database.parent
        command.extend(['--user-data-dir=' + str(profile_dir.parent),
                        '--profile-directory=' + profile_dir.name, '--new-window', url])
    # Launch only an ordinary browser window. We never read its DOM or drive
    # input. The user's browser stays open when setup finishes or is cancelled.
    subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)


def wait_for_console(account, browser, profile):
    deadline = time.monotonic() + 600
    opened = set()
    while True:
        try:
            console = ConsoleSession(account, browser, profile)
            if opened:
                emit('progress', 'Google sign-in detected. Continuing setup…')
            return console
        except GoogleSignInRequired as error:
            if error.destination not in opened:
                open_google_sign_in(account, browser, profile, error.destination)
                opened.add(error.destination)
                emit('progress', 'Sign in to Google in the window that opened. '
                     'Setup will continue automatically when sign-in is detected.')
            require(time.monotonic() < deadline,
                    'Google sign-in took too long. Finish signing in, then retry to resume setup.')
            time.sleep(3)


class ConsoleSession:
    origin = 'https://console.cloud.google.com'

    def __init__(self, account, browser, profile):
        import browser_cookie3

        loader_name = BROWSERS[browser][0]
        kwargs = {'domain_name': '.google.com'}
        database = cookie_database(browser, profile)
        if browser == 'firefox' and database is None:
            raise GoogleSignInRequired()
        if database:
            if not database.is_file():
                raise GoogleSignInRequired()
            kwargs['cookie_file'] = str(database)
        try:
            self.jar = getattr(browser_cookie3, loader_name)(**kwargs)
        except Exception:
            raise Refused('Could not read this browser profile. Unlock your desktop '
                          'keyring and choose a profile signed in to Google.') from None
        for cookie in list(self.jar):
            if not (cookie.domain == 'google.com' or cookie.domain.endswith('.google.com')):
                self.jar.clear(cookie.domain, cookie.path, cookie.name)
        if not any(c.name in ('SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID')
                   and not c.is_expired() for c in self.jar):
            raise GoogleSignInRequired()
        self.opener = urllib.request.build_opener(
            NoRedirect(), urllib.request.HTTPCookieProcessor(self.jar))
        self.page_opener = urllib.request.build_opener(
            GooglePageRedirect(), urllib.request.HTTPCookieProcessor(self.jar))
        request = urllib.request.Request(
            'https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard',
            data=b'', headers={'Origin': 'https://accounts.google.com',
                               'Content-Type': 'application/x-www-form-urlencoded'})
        try:
            raw = self.read(request).decode()
        except ApiRedirectRefused:
            raise GoogleSignInRequired() from None
        if raw.startswith(")]}'"):
            raw = raw.split('\n', 1)[1]
        rows = json.loads(raw)[1]
        matching = [row for row in rows if len(row) > 7
                    and isinstance(row[3], str) and row[3].lower() == account]
        if not matching:
            raise GoogleSignInRequired()
        require(len(matching) == 1, 'Google returned an ambiguous account selection.')
        self.authuser = str(matching[0][7])
        require(re.fullmatch(r'[0-9]{1,3}', self.authuser), 'Google returned an invalid account selector.')
        self.referer = self.origin + '/auth/clients?authuser=' + self.authuser
        page = self.read(urllib.request.Request(self.referer),
                         opener=self.page_opener, limit=PAGE_LIMIT, console_page=True).decode()
        keys = list(dict.fromkeys(re.findall(r'AIza[\w-]{35}', page)))
        require(keys, 'Google Console changed its setup page. Use manual setup for now.')
        self.routing_key = keys[0]

    def read(self, request, *, opener=None, limit=LIMIT, console_page=False):
        try:
            with (opener or self.opener).open(request, timeout=30) as response:
                if console_page and urllib.parse.urlsplit(response.url).hostname != 'console.cloud.google.com':
                    raise GoogleSignInRequired('console')
                body = response.read(limit + 1)
        except urllib.error.HTTPError as error:
            raise Refused('Google refused the setup request (HTTP ' + str(error.code)
                          + '). Check your Google Cloud session, or use manual setup.') from None
        require(len(body) <= limit, 'Google returned an oversized response.')
        return body

    def request(self, service, path, body=None):
        require(service in ('clientauthconfig', 'cloudconsole-pa'), 'Unsupported Google service.')
        require(path.startswith('/') and not any(c in path for c in ('..', '#', '\r', '\n')),
                'Invalid Google API path.')
        cookies = {c.name: c.value for c in self.jar if c.domain in ('.google.com', 'google.com')}
        timestamp = str(int(time.time()))
        hashes = []
        for name, scheme in [('SAPISID', 'SAPISIDHASH'),
                             ('__Secure-1PAPISID', 'SAPISID1PHASH'),
                             ('__Secure-3PAPISID', 'SAPISID3PHASH')]:
            if cookies.get(name):
                digest = hashlib.sha1(f'{timestamp} {cookies[name]} {self.origin}'.encode()).hexdigest()
                hashes.append(f'{scheme} {timestamp}_{digest}')
        require(hashes, 'The selected browser has no active Google Console session.')
        headers = {'Authorization': ' '.join(hashes), 'Origin': self.origin,
                   'Referer': self.referer, 'X-Goog-AuthUser': self.authuser,
                   'X-Goog-Api-Key': self.routing_key, 'Content-Type': 'application/json'}
        request = urllib.request.Request(f'https://{service}.clients6.google.com{path}',
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers=headers)
        return json.loads(self.read(request))

    def graphql(self, operation, variables, project):
        response = self.request('cloudconsole-pa', GRAPHQL, {
            'operationName': operation, 'querySignature': SIGNATURES[operation],
            'variables': variables, 'requestContext': {
                'projectId': project, 'selectedPurview': {'projectId': project}}})
        require(isinstance(response, list) and len(response) == 1,
                'Google Console changed its response format. Use manual setup for now.')
        results = response[0].get('results', [])
        require(len(results) == 1 and not results[0].get('errors'),
                'Google could not configure this personal app. Retry or use manual setup.')
        return results[0].get('data', {})


def setup(args):
    account = args.account.strip().lower()
    require(len(account) <= 254 and not account.startswith('-')
            and re.fullmatch(r'[^\s@\x00-\x1f\x7f]{1,200}@[^\s@\x00-\x1f\x7f]{1,200}', account),
            'Enter the Google account email address first.')
    require(sys.platform == 'linux', 'Automatic setup currently supports Linux. Use manual setup on this system.')
    require(shutil.which('gcloud'), 'Install Google Cloud CLI first: omarchy pkg aur add google-cloud-cli')
    emit('progress', 'Checking the selected Google browser session…')
    console = wait_for_console(account, args.browser, args.profile)
    config_home = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
    directory = private_dir(config_home / 'omamail')
    try:
        # Serializes all automatic setups, including different accounts updating the same store.
        lock = os.open('.google-setup.lock', os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=directory)
        try:
            info = os.fstat(lock)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and info.st_nlink == 1 and not info.st_mode & 0o077,
                    'The setup lock must be an owner-only regular file without links.')
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refused('Another automatic setup is running. Wait for it to finish.') from None
            provision(console, directory, account)
        finally:
            os.close(lock)
    finally:
        os.close(directory)


def provision(console, directory, account):
    state_name = 'google-setup-' + hashlib.sha256(account.encode()).hexdigest()[:24] + '.json'
    raw = read_private(directory, state_name)
    state = json.loads(raw) if raw else {
        'account': account, 'projectId': 'omamail-personal-' + secrets.token_hex(6)}
    require(state.get('account') == account, 'Saved setup belongs to another Google account.')
    project = state['projectId']
    require(re.fullmatch(r'omamail-personal-[a-f0-9]{12}', project), 'Invalid saved project ID.')
    owner_label = hashlib.sha256(account.encode()).hexdigest()[:24]
    saved_client = state.get('client')
    if saved_client is not None:
        require(isinstance(saved_client, dict)
                and saved_client.get('project_id') == project
                and saved_client.get('owner_email') == account
                and saved_client.get('publish_state') == 'PERSONAL'
                and re.fullmatch(r'[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com',
                                 str(saved_client.get('client_id', '')))
                and isinstance(saved_client.get('client_secret'), str)
                and 0 < len(saved_client['client_secret']) < 4096,
                'The saved client is invalid. No project settings were changed.')
    # Refuse before creating a project when the account already has another client.
    installed_raw = read_private(directory, 'credentials.json')
    installed = json.loads(installed_raw) if installed_raw else {}
    for entry in installed.get('accounts', []):
        if str(entry.get('id', '')).lower() == account:
            require(saved_client is not None and entry.get('installed') == saved_client,
                    'This account already has a different client. Use manual setup to change it; '
                    'no project settings were changed.')

    def checkpoint():
        nonlocal raw
        write_private(directory, state_name, state, raw)
        raw = read_private(directory, state_name)

    # Save the allocated ID before any mutation, so retries never allocate another project.
    checkpoint()
    emit('progress', 'Checking Google Cloud sign-in…')
    accounts = gcloud('auth', 'list', optional=True) or []
    if not any(row.get('account', '').lower() == account for row in accounts):
        emit('progress', 'Sign in to Google in the browser to allow personal app setup…')
        gcloud('auth', 'login', account, '--no-activate', '--brief', timeout=300)
    common = ('--account=' + account,)
    emit('progress', 'Creating your personal Google project…')
    found = gcloud('projects', 'describe', project, *common, optional=True)
    if found is None:
        found = gcloud('projects', 'create', project, '--name=OmaMail personal',
                       '--labels=omamail-personal-setup=' + owner_label, *common)
    require(found.get('projectId') == project and found.get('lifecycleState') == 'ACTIVE',
            'The personal project is not active. Retry shortly.')
    require(found.get('labels', {}).get('omamail-personal-setup') == owner_label,
            'The saved project was not created for this automatic setup. No project settings were changed.')
    number = str(found.get('projectNumber', ''))
    require(re.fullmatch(r'[0-9]{1,30}', number), 'Google returned an invalid project number.')
    state['projectNumber'] = number
    checkpoint()
    emit('progress', 'Enabling Gmail and Calendar…')
    gcloud('services', 'enable', 'gmail.googleapis.com', 'calendar-json.googleapis.com',
           '--project=' + project, *common, timeout=240)
    emit('progress', 'Configuring your personal permission screen…')
    brand = console.graphql('GetBrandInfo', {'projectNumber': number}, project).get('getBrandInfo', {})
    if not brand.get('isBrandConfigured'):
        console.graphql('CreateBrandInfo', {'request': {
            'projectNumber': number, 'displayName': 'OmaMail personal',
            'supportEmail': account, 'developerEmails': [account],
            'visibility': 'EXTERNAL', 'publishState': 'PERSONAL'}}, project)
        for _ in range(30):
            time.sleep(2)
            brand = console.graphql('GetBrandInfo', {'projectNumber': number}, project).get('getBrandInfo', {})
            if brand.get('isBrandConfigured'):
                break
    require(brand.get('isBrandConfigured') and brand.get('brandPolicy', {}).get('publishState') == 'PERSONAL'
            and str(brand.get('brand', {}).get('brandId')) == number
            and str(brand.get('brand', {}).get('supportEmail', '')).lower() == account,
            'Google did not confirm owner-only PERSONAL mode. No credentials were installed.')
    if not state.get('client'):
        emit('progress', 'Creating your Desktop client…')
        listing = console.request('clientauthconfig', '/v1/clients?' + urllib.parse.urlencode({
            'projectNumber': number, 'readMask': 'client_id,display_name,type'}))
        require(not listing.get('clients'),
                'A client already exists but its secret was not saved. Recover it through manual setup; '
                'automatic setup will not create duplicate clients.')
        client = console.request('clientauthconfig', '/v1/clients', {
            'type': 'NATIVE_DESKTOP', 'displayName': 'OmaMail Desktop',
            'authType': 'SHARED_SECRET', 'brandId': number, 'projectNumber': number})
        client_id = client.get('clientId', '')
        client_secrets = client.get('clientSecrets', [])
        secret = client_secrets[0].get('clientSecret', '') if client_secrets else ''
        require(re.fullmatch(r'[0-9]+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com', client_id)
                and isinstance(secret, str) and 0 < len(secret) < 4096,
                'Google returned an incomplete Desktop client. Recover it through manual setup.')
        state['client'] = {'client_id': client_id, 'client_secret': secret, 'project_id': project,
                           'auth_uri': 'https://accounts.google.com/o/oauth2/v2/auth',
                           'token_uri': 'https://oauth2.googleapis.com/token',
                           'redirect_uris': ['http://localhost'], 'owner_email': account,
                           'publish_state': 'PERSONAL'}
        checkpoint()
    emit('progress', 'Saving the personal client…')
    existing = read_private(directory, 'credentials.json')
    store = json.loads(existing) if existing else {'version': 2, 'accounts': []}
    if 'accounts' not in store:
        require('installed' in store, 'Existing client file has an unknown format; no changes were made.')
        store = {'version': 2, 'accounts': [{'id': '', 'installed': store['installed']}]}
    require(store.get('version') == 2 and isinstance(store['accounts'], list),
            'Existing client file has an unknown format; no changes were made.')
    entries = store['accounts']
    previous = [entry for entry in entries if str(entry.get('id', '')).lower() == account]
    require(len(previous) <= 1, 'The client file has duplicate accounts; no changes were made.')
    if previous:
        require(previous[0].get('installed') == state['client'],
                'This account already has a different client. No existing credentials were replaced.')
    else:
        entries.append({'id': account, 'installed': state['client']})
    write_private(directory, 'credentials.json', store, existing)
    emit('done', 'Personal client ready. Continue with Google sign-in.', projectId=project)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--install-tools', action='store_true')
    parser.add_argument('--browser', choices=BROWSERS, default='edge')
    parser.add_argument('--profile', help='Optional cookie database path for another browser profile')
    args = parser.parse_args()
    require(sys.platform == 'linux', 'Automatic setup currently supports Linux. Use manual setup on this system.')
    if args.check:
        preflight()
        return
    if args.install_tools:
        install_tools()
        return
    require(args.account, 'Enter the Google account email address first.')
    require(shutil.which('gcloud'), 'Install Google Cloud CLI first: omarchy pkg aur add google-cloud-cli')
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    # uv prepares a cached, isolated environment; never install into system Python.
    try:
        import browser_cookie3  # noqa: F401
    except ImportError:
        require(shutil.which('uv'), 'Install the setup dependency manager first: omarchy pkg add uv')
        require(not os.environ.get('OMAMAIL_GOOGLE_SETUP_DEPS'), 'Could not load the setup dependency.')
        os.environ['OMAMAIL_GOOGLE_SETUP_DEPS'] = '1'
        emit('progress', 'Preparing the local Google setup helper…')
        os.execvp('uv', ['uv', 'run', '--quiet', '--no-project', '--script', __file__, *sys.argv[1:]])
    setup(args)


if __name__ == '__main__':
    try:
        main()
    except Refused as error:
        emit('error', str(error))
        raise SystemExit(1)
    except Exception:
        # Third-party libraries, HTTP and subprocess exceptions can contain secrets.
        emit('error', 'Automatic setup could not finish. Your progress is saved; retry or use manual setup.')
        raise SystemExit(1)
