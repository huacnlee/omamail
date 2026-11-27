# JMAP discovery and streaming

Required when touching JMAP discovery, authentication or event streams.

- Start discovery at the address domain's HTTPS well-known URL or the explicit user-configured server. Unauthenticated DNS SRV answers cannot authorize credential destinations; probing the target over HTTPS proves its identity, not its relationship to the mailbox domain.
- Discovery, session checks and requests are in `core/src/providers/jmap/` (`discovery.rs`, `check.rs`, `mod.rs`). Follow [security boundaries](../SECURITY-BOUNDARIES.md) for deadlines, size bounds and credential scope.
- `core/src/providers/jmap/stream.rs` reads the event stream and bounds each event before forwarding it, normalizing CR, LF and CRLF to LF. Bound buffering while reading, not after an event has been collected. Stopping or refusing the stream must close the connection too.
