//! Interrupt the input wait when the peer can no longer receive responses.
use std::io::{self, BufReader, Read, Write};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub fn serve() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    bind_to_parent()?;
    let failed = Arc::new(AtomicBool::new(false));
    super::protocol::serve(
        BufReader::new(Input {
            failed: failed.clone(),
        }),
        Output {
            inner: io::stdout(),
            failed,
        },
    )
}

#[cfg(target_os = "linux")]
fn bind_to_parent() -> io::Result<()> {
    // Register before the protocol starts runtime threads. This applies only
    // to serve, not CLI commands or deliberately detached agent workers.
    // Linux ties this to the creating parent thread, not its whole process.
    // SIGKILL cannot be blocked/ignored by an inherited signal disposition;
    // the kernel releases the outbox lock even if another process holds stdin.
    let parent = unsafe { libc::getppid() };
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // prctl does not signal retroactively: reject a parent that died between
    // the observation and registration. A parent lost before our first
    // observation (including reparenting to a subreaper) cannot be identified
    // without an identity supplied by the launcher.
    if unsafe { libc::getppid() } != parent {
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "backend parent exited during startup",
        ));
    }
    Ok(())
}

struct Input {
    failed: Arc<AtomicBool>,
}

impl Read for Input {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        #[cfg(windows)]
        {
            // Windows anonymous pipes do not support poll(2). A failed stdout
            // will be observed before the next request; otherwise the blocking
            // stdin read is exactly the backend protocol's required wait.
            return io::stdin().read(bytes);
        }
        #[cfg(unix)]
        loop {
            if self.failed.load(Ordering::Acquire) {
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "output closed"));
            }
            let mut descriptor = libc::pollfd {
                fd: libc::STDIN_FILENO,
                events: libc::POLLIN,
                revents: 0,
            };
            // The backend is the only stdin reader. Read the descriptor directly:
            // a buffered Stdin reader could contain bytes invisible to poll.
            let ready = unsafe { libc::poll(&mut descriptor, 1, 100) };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if ready == 0 {
                continue;
            }
            // POLLHUP may accompany unread bytes. Read them before reporting EOF.
            // SAFETY: bytes supplies a valid writable buffer of the stated size.
            let count =
                unsafe { libc::read(libc::STDIN_FILENO, bytes.as_mut_ptr().cast(), bytes.len()) };
            if count >= 0 {
                return Ok(count as usize);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

struct Output {
    inner: io::Stdout,
    failed: Arc<AtomicBool>,
}

impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let result = self.inner.write(bytes);
        if result
            .as_ref()
            .is_err_and(|e| e.kind() != io::ErrorKind::Interrupted)
            || matches!(result, Ok(0)) && !bytes.is_empty()
        {
            self.failed.store(true, Ordering::Release);
        }
        result
    }

    fn flush(&mut self) -> io::Result<()> {
        let result = self.inner.flush();
        if result.is_err() {
            self.failed.store(true, Ordering::Release);
        }
        result
    }
}
