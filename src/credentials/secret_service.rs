//! Secret Service over D-Bus, retaining the installed plugin's exact attributes.
//! Each blocking worker owns an async runtime and connection. The total deadline
//! covers connection setup, every method and prompt completion; cancellation
//! drops the operation, closes the connection and tears down its runtime.
use super::*;
use ::secret_service::{EncryptionType, SecretService};
use std::{collections::HashMap, future::Future, time::Duration};

const DEADLINE: Duration = Duration::from_secs(5);
const CLOSE_DEADLINE: Duration = Duration::from_millis(250);

enum Operation<'a> {
    Get,
    Put(&'a [u8]),
    Delete,
}

fn run(key: &CredentialKey, operation: Operation<'_>) -> Result<Option<Secret>, Error> {
    run_with(
        key,
        operation,
        async {
            zbus::connection::Builder::session()
                .map_err(|_| Error::Unavailable)?
                .method_timeout(DEADLINE)
                .build()
                .await
                .map_err(|_| Error::Unavailable)
        },
        DEADLINE,
    )
}

fn run_with(
    key: &CredentialKey,
    operation: Operation<'_>,
    connect: impl Future<Output = Result<zbus::Connection, Error>>,
    deadline: Duration,
) -> Result<Option<Secret>, Error> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| Error::Unavailable)?;
    let result = runtime.block_on(async {
        let mut connection = None;
        let result = tokio::time::timeout(deadline, async {
            let connected = connect.await?;
            connection = Some(connected.clone());
            let service = SecretService::connect_with_existing(EncryptionType::Dh, connected)
                .await
                .map_err(|_| Error::Unavailable)?;
            execute(&service, key, operation).await
        })
        .await
        .unwrap_or(Err(Error::Unavailable));
        // This is close, never graceful_shutdown: waiting for a pending prompt
        // or outstanding clone before closing would recreate the indefinite wait.
        if let Some(connection) = connection {
            let _ = tokio::time::timeout(CLOSE_DEADLINE, connection.close()).await;
        }
        result
    });
    // zbus's async reader/signal tasks are owned by this runtime. There is no
    // detached blocking secret-service call left behind when the worker returns.
    runtime.shutdown_timeout(Duration::ZERO);
    result
}

async fn find<'a>(
    service: &'a SecretService<'a>,
    attrs: &HashMap<String, String>,
) -> Result<Option<::secret_service::Item<'a>>, Error> {
    let result = service
        .search_items(
            attrs
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect(),
        )
        .await
        .map_err(|_| Error::Unavailable)?;
    if !result.locked.is_empty() {
        return Err(Error::Unavailable);
    }
    if result.unlocked.len() > 1 {
        return Err(Error::Ambiguous);
    }
    Ok(result.unlocked.into_iter().next())
}

async fn execute(
    service: &SecretService<'_>,
    key: &CredentialKey,
    operation: Operation<'_>,
) -> Result<Option<Secret>, Error> {
    let attrs = key.attributes()?.into_iter().collect();
    let item = find(service, &attrs).await?;
    match operation {
        Operation::Get => {
            let item = item.ok_or(Error::Missing)?;
            Ok(Some(Secret::new(
                item.get_secret().await.map_err(|_| Error::Unavailable)?,
            )?))
        }
        Operation::Put(secret) => {
            if let Some(item) = item {
                item.set_secret(secret, "application/octet-stream")
                    .await
                    .map_err(|_| Error::Unavailable)?;
            } else {
                let collection = service
                    .get_default_collection()
                    .await
                    .map_err(|_| Error::Unavailable)?;
                if collection
                    .is_locked()
                    .await
                    .map_err(|_| Error::Unavailable)?
                {
                    return Err(Error::Unavailable);
                }
                // Keep older grants intact until the current-scope item exists.
                collection
                    .create_item(
                        "Omamail",
                        attrs
                            .iter()
                            .map(|(k, v)| (k.as_str(), v.as_str()))
                            .collect(),
                        secret,
                        false,
                        "application/octet-stream",
                    )
                    .await
                    .map_err(|_| Error::Unavailable)?;
            }
            Ok(None)
        }
        Operation::Delete => {
            item.ok_or(Error::Missing)?
                .delete()
                .await
                .map_err(|_| Error::Unavailable)?;
            Ok(None)
        }
    }
}

pub(super) fn get(key: &CredentialKey) -> Result<Secret, Error> {
    run(key, Operation::Get)?.ok_or(Error::Unavailable)
}
pub(super) fn put(key: &CredentialKey, secret: &[u8]) -> Result<(), Error> {
    run(key, Operation::Put(secret)).map(|_| ())
}
pub(super) fn delete(key: &CredentialKey) -> Result<(), Error> {
    run(key, Operation::Delete).map(|_| ())
}

#[cfg(test)]
#[path = "secret_service_tests.rs"]
mod tests;
