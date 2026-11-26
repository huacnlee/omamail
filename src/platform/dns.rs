//! Host name resolution that works where the backend runs.
//!
//! Desktop builds use hickory, which reads the system resolver configuration
//! (`/etc/resolv.conf` on Unix). Android has no such file, and an iOS app
//! sandbox cannot rely on it either, so on phones every lookup goes through
//! the platform resolver (`getaddrinfo`, via `tokio::net::lookup_host`). That
//! follows the OS's own DNS settings: private DNS, VPN and per-network servers.
//!
//! Callers that pin connections to checked addresses (`public_http`) still
//! see every answer before connecting; only the resolver changes.
use std::net::IpAddr;

/// Whether reqwest clients should use their built-in hickory resolver.
/// When false, reqwest falls back to `getaddrinfo` on a blocking thread.
pub(crate) const HICKORY: bool = !MOBILE;
const MOBILE: bool = cfg!(any(target_os = "ios", target_os = "android"));

/// All addresses for `host`, IPv4 and IPv6, in the resolver's order.
pub(crate) async fn lookup_ips(host: &str) -> std::io::Result<Vec<IpAddr>> {
    if MOBILE {
        system_lookup(host).await
    } else {
        hickory_lookup(host).await
    }
}

async fn system_lookup(host: &str) -> std::io::Result<Vec<IpAddr>> {
    let mut ips = Vec::new();
    for address in tokio::net::lookup_host((host, 0)).await? {
        if !ips.contains(&address.ip()) {
            ips.push(address.ip());
        }
    }
    Ok(ips)
}

async fn hickory_lookup(host: &str) -> std::io::Result<Vec<IpAddr>> {
    use hickory_resolver::{TokioResolver, config::LookupIpStrategy};
    let mut builder = TokioResolver::builder_tokio().map_err(std::io::Error::other)?;
    builder.options_mut().ip_strategy = LookupIpStrategy::Ipv4AndIpv6;
    let answer = builder
        .build()
        .lookup_ip(host)
        .await
        .map_err(std::io::Error::other)?;
    Ok(answer.iter().collect())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn system_lookup_answers_numeric_and_local_names_without_hickory() {
        assert_eq!(
            super::system_lookup("127.0.0.1").await.unwrap(),
            ["127.0.0.1".parse::<std::net::IpAddr>().unwrap()]
        );
        let local = super::system_lookup("localhost").await.unwrap();
        assert!(!local.is_empty() && local.iter().all(|ip| ip.is_loopback()));
    }
}

/// Run on an iOS simulator or device (not in CI): the phone code paths for
/// DNS and the sandbox storage walk, against the real OS. Run it with HOME
/// and TMPDIR set to an app container, e.g. `SIMCTL_CHILD_HOME=<container>
/// SIMCTL_CHILD_TMPDIR=<container>/tmp/ xcrun simctl spawn booted <test binary>
/// --ignored ios_native`.
#[cfg(all(test, target_os = "ios"))]
mod ios_native {
    #[tokio::test]
    #[ignore = "requires an iOS simulator or device and network access"]
    async fn ios_native_dns_and_storage() {
        // DNS through getaddrinfo, then a TCP connection to an IMAP server.
        let ips = super::lookup_ips("imap.gmail.com").await.unwrap();
        assert!(!ips.is_empty());
        let address = std::net::SocketAddr::new(ips[0], 993);
        tokio::net::TcpStream::connect(address).await.unwrap();

        // Private storage below the canonical HOME.
        let dirs = crate::platform::dirs::AppDirs::discover().unwrap();
        let home = std::fs::canonicalize(std::env::var_os("HOME").unwrap()).unwrap();
        for root in [&dirs.config, &dirs.cache, &dirs.state, &dirs.runtime] {
            assert!(root.starts_with(&home), "{root:?} outside {home:?}");
            crate::platform::private_fs::directories(root, &["omamail"], true)
                .unwrap()
                .unwrap();
        }
        println!("HOME {home:?}, cache {:?}", dirs.cache);
    }
}
