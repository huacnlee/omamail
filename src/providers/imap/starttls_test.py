"""Synthetic IMAP/SMTP peer: credentials must arrive only inside TLS."""
import pathlib
import socket
import ssl
import sys

smtp = sys.argv[1] == "smtp"
mode = sys.argv[2]
implicit = sys.argv[3] == "implicit"
root = pathlib.Path(__file__).parent.parent / "testdata" / "tls"
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(root / "server.pem", root / "server-key.pem")


def line(connection):
    result = bytearray()
    while not result.endswith(b"\r\n"):
        chunk = connection.recv(1)
        if not chunk:
            break
        result.extend(chunk)
        assert len(result) < 4096
    return bytes(result)


def greeting(connection):
    connection.sendall(b"220 ready\r\n" if smtp else b"* OK ready\r\n")


with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listener.settimeout(10)
    print(listener.getsockname()[1], flush=True)
    connection, _ = listener.accept()
    with connection:
        connection.settimeout(5)
        if not implicit:
            greeting(connection)
            if smtp:
                assert line(connection) == b"EHLO omamail\r\n"
                connection.sendall(b"250-localhost\r\n250 STARTTLS\r\n")
            assert line(connection) == (b"STARTTLS\r\n" if smtp else b"O1 STARTTLS\r\n")
            if mode == "refuse":
                connection.sendall(b"454 refused\r\n" if smtp else b"O1 NO refused\r\n")
                assert line(connection) == b""
                print("no-credentials", flush=True)
                sys.exit(0)
            reply = b"220 upgrade\r\n" if smtp else b"O1 OK upgrade\r\n"
            if mode == "buffered":
                connection.sendall(reply + b"plaintext-after-upgrade\r\n")
                # A reset also discards the injected plaintext. Neither path
                # may contain credential bytes (a ClientHello is harmless).
                received = bytearray()
                try:
                    while chunk := connection.recv(4096):
                        received.extend(chunk)
                except ConnectionResetError:
                    pass
                assert b"synthetic-credential" not in received
                print("no-credentials", flush=True)
                sys.exit(0)
            connection.sendall(reply)
            if mode == "malformed":
                connection.sendall(b"not-a-tls-record")
                received = bytearray()
                try:
                    while chunk := connection.recv(4096):
                        received.extend(chunk)
                except ConnectionResetError:
                    pass
                assert b"synthetic-credential" not in received
                print("no-credentials", flush=True)
                sys.exit(0)
        try:
            with context.wrap_socket(connection, server_side=True) as secure:
                assert mode == "local"
                if implicit:
                    greeting(secure)
                assert line(secure) == b"synthetic-credential\r\n"
                print("encrypted-credentials", flush=True)
        except ssl.SSLError:
            assert mode == "strict"
            print("no-credentials", flush=True)
