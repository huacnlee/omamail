# JMAP discovery and streaming

Required when touching JMAP discovery, authentication or event streams.

- Start discovery at the address domain's HTTPS well-known URL or the explicit user-configured server. Unauthenticated DNS SRV answers cannot authorize credential destinations; probing the target over HTTPS proves its identity, not its relationship to the mailbox domain.
- The legacy `scripts/jmap-transport.sh` exchanges base64 stdin fields and a four-line response. Follow [security boundaries](../SECURITY-BOUNDARIES.md) for curl configuration.
- `scripts/jmap-stream.py` owns curl and bounds each event before forwarding it, normalizing CR, LF and CRLF to LF. Checking after QML's `SplitParser` is too late to bound buffering. Stopping or refusing the stream must terminate curl too.
