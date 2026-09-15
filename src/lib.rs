pub mod account;
// Detached assistant workers currently rely on Linux pidfds and private storage.
#[cfg(all(feature = "agent", target_os = "linux"))]
pub mod agent;
pub mod attachment;
pub mod auth;
pub mod backend;
pub mod cache;
pub mod calendar;
pub mod cli;
pub mod compose;
pub mod contacts;
pub mod credentials;
pub mod mail;
pub mod message;
pub mod outbox;
pub mod platform;
pub mod process;
pub mod providers;
pub mod public_http;
pub mod sync;
pub mod tls;

#[cfg(test)]
pub(crate) mod test_net {
    /// The synthetic peers listen on 127.0.0.1 and hold a certificate for
    /// `localhost`, so the tests connect by that name. Resolving it on a CI
    /// host has cost ten seconds a connection: the IPv6 loopback answer
    /// comes first and the attempt on it is left to time out before IPv4 is
    /// tried, which turned a thirty-second suite into ten minutes on macOS.
    /// The name is pinned to the address the peer actually has; the
    /// certificate is still checked against the name.
    pub(crate) fn localhost_loopback(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
        builder.resolve("localhost", std::net::SocketAddr::from(([127, 0, 0, 1], 0)))
    }
}
