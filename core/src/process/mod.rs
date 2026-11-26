//! Bounded subprocess transport for providers with an official command interface.
//! Arguments go directly to the OS process API; no shell interprets them.
pub mod async_run;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

pub type Error = &'static str;

/// Preserve the synchronous provider contract: bounded stdout on success and
/// stable error codes, never child diagnostics on failure.
pub fn run(
    program: &str,
    args: &[String],
    input: &[u8],
    timeout: Duration,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    platform::run(program, args, input, timeout, limit)
}

/// An owned child and its process group / job. Dropping it terminates the tree.
/// Pipes can be taken by a caller that needs streaming or its own protocol.
pub struct ManagedChild {
    child: Child,
    tree: platform::Tree,
}

pub fn spawn_managed(program: &str, args: &[String]) -> Result<ManagedChild, Error> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    platform::configure(&mut command);
    let mut child = command.spawn().map_err(|_| "process_unavailable")?;
    let tree = match platform::Tree::for_child(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    Ok(ManagedChild { child, tree })
}

impl ManagedChild {
    pub fn id(&self) -> u32 {
        self.child.id()
    }
    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }
    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }
    pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Kill the owned process tree and reap the direct child within this budget.
    /// A timeout is reported rather than waiting indefinitely on inherited pipes.
    /// Unix containment is a process group: deliberately detached descendants
    /// are outside that group, so transports must also close their own readers.
    pub fn terminate_tree(&mut self, deadline: Duration) -> Result<(), Error> {
        let started = Instant::now();
        self.child.stdin.take();
        self.child.stdout.take();
        self.child.stderr.take();
        let result = self.tree.terminate();
        let _ = self.child.kill();
        loop {
            if self
                .child
                .try_wait()
                .map_err(|_| "process_wait_failed")?
                .is_some()
            {
                return result;
            }
            if started.elapsed() >= deadline {
                return Err("process_timed_out");
            }
            std::thread::sleep(
                Duration::from_millis(2).min(deadline.saturating_sub(started.elapsed())),
            );
        }
    }
}
impl Drop for ManagedChild {
    fn drop(&mut self) {
        let _ = self.terminate_tree(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests;
