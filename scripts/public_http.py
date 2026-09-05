"""One bounded request to a checked public IP, retaining the original TLS name.

Only sender-selected image and unsubscribe URLs use this transport. CalDAV and
mail servers may legitimately be private and must not use this policy.
"""

import base64
from contextlib import contextmanager
import http.client
import ipaddress
import re
import signal
import socket
import ssl
from urllib.parse import quote, urlsplit

MAX_INPUT = 128 * 1024
MAX_IMAGE = 5 * 1024 * 1024
REQUEST_SECONDS = 20
CONNECT_SECONDS = 10
# Keep transition/special-purpose exclusions stable across Python versions.
SPECIAL_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "192.0.0.0/24", "192.88.99.0/24", "64:ff9b::/96", "64:ff9b:1::/48", "2001::/23", "2002::/16",
))


class Refused(ValueError):
    pass


@contextmanager
def deadline(seconds=REQUEST_SECONDS):
    # Terminate this standalone worker at the OS level. A Python signal handler
    # may run only after a blocking C resolver returns; SIG_DFL needs no Python
    # bytecode to run. The QML caller treats a terminated worker as failure.
    # No temporary files or credentials need cleanup in these workers.
    previous = signal.signal(signal.SIGALRM, signal.SIG_DFL)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def read_fields(stream, count):
    line = stream.readline(MAX_INPUT + 1)
    if len(line) > MAX_INPUT or not line.endswith(b"\n"):
        raise Refused("Invalid request envelope")
    fields = line[:-1].split(b" ")
    if len(fields) != count:
        raise Refused("Invalid request envelope")
    values = []
    for field in fields:
        data = base64.b64decode(field, validate=True)
        if base64.b64encode(data) != field:
            raise Refused("Invalid request encoding")
        values.append(data.decode("utf-8"))
    return values


def public_address(value):
    address = ipaddress.ip_address(value)
    if not address.is_global or address.is_multicast or address.is_reserved:
        return False
    if any(address in network for network in SPECIAL_NETWORKS):
        return False
    if isinstance(address, ipaddress.IPv6Address):
        # Refuse transition mechanisms whose effective IPv4 destination can
        # differ from what a global-looking IPv6 address suggests.
        if address.ipv4_mapped or address.sixtofour or address.teredo:
            return False
    return True


def parse_url(value, https_only=False):
    # urlsplit itself drops some controls; reject them BEFORE it sees the URL.
    if not value or re.search(r"[\x00-\x20\x7f\\]", value):
        raise Refused("Invalid URL characters")
    parsed = urlsplit(value)
    if parsed.scheme not in (("https",) if https_only else ("http", "https")):
        raise Refused("Unsupported URL scheme")
    if parsed.username is not None or parsed.password is not None:
        raise Refused("URL credentials are not allowed")
    host = (parsed.hostname or "").encode("idna").decode("ascii").lower()
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if (len(host) > 253 or "." not in host or
                not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                        for label in host.split("."))):
            raise Refused("Invalid public host") from None
    else:
        if not public_address(host):
            raise Refused("Non-public destination")
    port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
    if not 1 <= port <= 65535:
        raise Refused("Invalid port")
    # Percent escapes retain their meaning; raw Unicode becomes UTF-8 escapes.
    target = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    if parsed.query:
        target += "?" + quote(parsed.query, safe="/%?:@!$&'()*+,;=-._~")
    return parsed.scheme, host, port, target


def resolve_public(host, port):
    answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    if not answers:
        raise Refused("The host has no public address")
    # Reject the entire mixed answer, not merely the first or preferred IP.
    for family, _kind, _protocol, _name, address in answers:
        if family not in (socket.AF_INET, socket.AF_INET6) or not public_address(address[0]):
            raise Refused("Non-public destination")
    return answers


class PublicConnection(http.client.HTTPConnection):
    def __init__(self, scheme, host, port):
        super().__init__(host, port, timeout=CONNECT_SECONDS)
        self.secure = scheme == "https"
        self.context = ssl.create_default_context() if self.secure else None
        if self.context:
            self.context.set_alpn_protocols(["http/1.1"])

    def connect(self):
        answers = resolve_public(self.host, self.port)
        last_error = None
        for family, kind, protocol, _name, address in answers:
            sock = socket.socket(family, kind, protocol)
            try:
                sock.settimeout(CONNECT_SECONDS)
                # Numeric sockaddr from the validated answer: no second DNS
                # lookup, proxy environment, CONNECT tunnel or URL expansion.
                sock.connect(address)
                if self.context:
                    sock = self.context.wrap_socket(sock, server_hostname=self.host)
                self.sock = sock
                return
            except OSError as error:
                last_error = error
                sock.close()
            except BaseException:
                sock.close()
                raise
        raise last_error or Refused("No reachable public address")


@contextmanager
def response_for(url, method, body=None, headers=None, https_only=False):
    scheme, host, port, target = parse_url(url, https_only)
    connection = PublicConnection(scheme, host, port)
    try:
        connection.request(method, target, body=body, headers=headers or {})
        response = connection.getresponse()
        try:
            # http.client returns 3xx as responses; it never follows Location.
            yield response
        finally:
            response.close()
    finally:
        connection.close()


def unsubscribe(url):
    with response_for(url, "POST", body=b"List-Unsubscribe=One-Click",
                      headers={"Content-Type": "application/x-www-form-urlencoded"},
                      https_only=True) as response:
        # Do not download a sender-controlled response body just to discard it.
        return response.status


def image_mime(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"BM"):
        return "image/bmp"
    raise Refused("Unsupported image data")


def fetch_image(url):
    with response_for(url, "GET") as response:
        if not 200 <= response.status < 300:
            raise Refused("The image server refused the request")
        if response.getheader("Content-Encoding", "identity").lower() != "identity":
            raise Refused("Encoded image responses are not supported")
        length = response.getheader("Content-Length")
        if length is not None and (not length.isascii() or not length.isdigit() or int(length) > MAX_IMAGE):
            raise Refused("Invalid image size")
        data = response.read(MAX_IMAGE + 1)
        if len(data) > MAX_IMAGE:
            raise Refused("Image exceeds the size limit")
        mime = image_mime(data)
        claimed = response.getheader("Content-Type", "").split(";", 1)[0].strip().lower()
        if claimed == "image/jpg":
            claimed = "image/jpeg"
        if claimed != mime:
            raise Refused("Image type does not match its data")
        return "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")
