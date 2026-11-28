use std::sync::{Mutex, OnceLock};

use omamail::platform::app_config;
use tokio::{
    runtime::{Builder, Runtime},
    task::AbortHandle,
};

const FILE: &str = "analytics.json";

struct BatchState {
    blocked: bool,
    active: Option<AbortHandle>,
}

impl BatchState {
    fn block(&mut self) {
        self.blocked = true;
        if let Some(task) = self.active.take() {
            task.abort();
        }
    }
}

static SENDS: Mutex<BatchState> = Mutex::new(BatchState {
    blocked: false,
    active: None,
});

pub fn write_consent(allowed: bool) -> Result<(), String> {
    let mut state = SENDS.lock().map_err(|_| "analytics_unavailable")?;
    if !allowed {
        state.block();
    }
    app_config::write(FILE, if allowed { "true" } else { "false" })?;
    state.blocked = !allowed;
    Ok(())
}

pub async fn send_batch(body: String) -> Result<u16, String> {
    let request = {
        let mut state = SENDS.lock().map_err(|_| "analytics_unavailable")?;
        if state.blocked {
            return Ok(400);
        }
        if state
            .active
            .as_ref()
            .is_some_and(|task| !task.is_finished())
        {
            return Err("analytics_busy".into());
        }
        // The mail worker can shut down during the app's quit flush.
        static RUNTIME: OnceLock<Option<Runtime>> = OnceLock::new();
        let runtime = RUNTIME
            .get_or_init(|| {
                Builder::new_multi_thread()
                    .worker_threads(1)
                    .enable_all()
                    .build()
                    .ok()
            })
            .as_ref()
            .ok_or_else(|| "analytics_unavailable".to_owned())?;
        let request = runtime.spawn(async move {
            if !matches!(app_config::read(FILE), Ok(Some(text)) if text == "true") {
                return Ok(400);
            }
            omamail::public_http::post_usage_batch(body).await
        });
        state.active = Some(request.abort_handle());
        request
    };
    request
        .await
        .map_err(|_| "analytics_unavailable".to_owned())?
        .map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn opting_out_aborts_a_batch_waiting_to_connect() {
        let (attempt, gate) = oneshot::channel();
        let request = tokio::spawn(async { gate.await });
        let mut state = BatchState {
            blocked: false,
            active: Some(request.abort_handle()),
        };

        state.block();
        assert!(state.blocked);
        assert!(state.active.is_none());
        assert!(request.await.unwrap_err().is_cancelled());
        assert!(attempt.send(()).is_err());
    }
}
