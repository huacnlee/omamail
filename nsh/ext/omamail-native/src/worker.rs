//! The thread that runs the mail library. `omamail::api` futures are not
//! `Send`, so, as in `omamail serve`, one thread drives them all with
//! `block_on` on a `LocalSet`; the library's own work uses the runtime's
//! pool. Callers await a oneshot reply from any executor.

use std::{future::Future, pin::Pin, rc::Rc, sync::OnceLock};

use omamail::api::Mail;
use tokio::sync::{mpsc, oneshot};

type Job = Box<dyn FnOnce(Rc<Mail>) -> Pin<Box<dyn Future<Output = ()>>> + Send>;

static JOBS: OnceLock<Option<mpsc::UnboundedSender<Job>>> = OnceLock::new();

fn jobs() -> Option<&'static mpsc::UnboundedSender<Job>> {
    JOBS.get_or_init(|| {
        let runtime = match omamail::backend::runtime() {
            Ok(runtime) => runtime,
            Err(error) => {
                log::error!("omamail: no runtime: {error}");
                return None;
            }
        };
        let (sender, mut queue) = mpsc::unbounded_channel::<Job>();
        std::thread::Builder::new()
            .name("omamail".into())
            .spawn(move || {
                let mail = Rc::new(Mail::default());
                let local = tokio::task::LocalSet::new();
                runtime.block_on(local.run_until(async move {
                    while let Some(job) = queue.recv().await {
                        tokio::task::spawn_local(job(mail.clone()));
                    }
                }));
            })
            .ok()?;
        Some(sender)
    })
    .as_ref()
}

/// Runs `f` with the library on the worker thread; its result, or the
/// backend's error code.
pub async fn run<T, F, Fut>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Rc<Mail>) -> Fut + Send + 'static,
    Fut: Future<Output = Result<T, omamail::api::Error>> + 'static,
{
    let (reply, answer) = oneshot::channel();
    let job: Job = Box::new(move |mail| {
        Box::pin(async move {
            let _ = reply.send(f(mail).await.map_err(|e| e.0));
        })
    });
    jobs()
        .ok_or("backend_unavailable")?
        .send(job)
        .map_err(|_| "backend_unavailable".to_owned())?;
    answer.await.map_err(|_| "backend_unavailable".to_owned())?
}
