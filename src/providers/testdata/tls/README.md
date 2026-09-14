# Synthetic TLS fixture

These files contain a test-only CA, a `localhost` server certificate, and its
private key. They do not protect any deployed service or user data.

The fixed chain keeps the native TLS tests independent of platform OpenSSL
certificate-generation differences. The CA is constrained to one intermediate
level and certificate signing. The leaf is constrained to TLS server use and
names only `localhost`. Both certificates expire on 11 September 2036.
