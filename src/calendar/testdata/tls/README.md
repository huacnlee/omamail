# Synthetic calendar TLS fixture

This test-only CA, server certificate and private key protect no deployed service or user data. Only the loopback discovery peer loads the key; Rust's test-only client explicitly trusts the CA and pins every test name to that peer. Production trust roots and TLS verification are unchanged.

The fixed chain follows the provider TLS fixtures: it removes runtime OpenSSL executable/configuration differences. The CA permits certificate signing with no intermediate CAs. The leaf is not a CA, permits TLS server authentication, and names `caldav.icloud.com`, `p37-caldav.icloud.com`, `graph.microsoft.com` and `outside.example.test`. The latter deliberately also has a valid certificate, so a credential-origin policy failure cannot hide behind a hostname mismatch. Both certificates expire in September 2036.

The fixtures were generated with OpenSSL 3.6.4, an explicit configuration, SHA-256, RSA-2048 keys, and separate CA/leaf extensions. The CA's private key is not tracked. Replace the chain before expiry; never install this CA in a system trust store or use these public test keys outside the fixtures.
