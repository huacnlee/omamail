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
    let cancellation = Arc::new(super::protocol::Cancellation::default());
    let finished = AtomicBool::new(false);
    std::thread::scope(|_scope| {
        #[cfg(unix)]
        _scope.spawn(|| {
            // The input thread can be blocked submitting to a full queue.
            // Observe output closure independently so cancellation drops that
            // queue and wakes its sender as well as all running requests.
            while !finished.load(Ordering::Acquire) {
                let mut output = output_descriptor(libc::STDOUT_FILENO);
                let ready = unsafe { libc::poll(&mut output, 1, 100) };
                if output.revents != 0
                    || failed.load(Ordering::Acquire)
                    || (ready < 0
                        && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted)
                {
                    failed.store(true, Ordering::Release);
                    cancellation.cancel();
                    break;
                }
            }
        });
        let result = super::protocol::serve_with_cancel(
            BufReader::new(Input {
                failed: failed.clone(),
            }),
            Output {
                inner: io::stdout(),
                failed: failed.clone(),
            },
            cancellation.clone(),
        );
        finished.store(true, Ordering::Release);
        result
    })
}

#[cfg(unix)]
fn output_descriptor(fd: libc::c_int) -> libc::pollfd {
    // Darwin registers no kqueue filter for events=0. Requesting POLLHUP
    // registers its read filter, which watches closure on a pipe's write end
    // without waking for ordinary writable capacity. Linux also reports pipe
    // errors with this mask. Never request POLLOUT: it would spin while idle.
    libc::pollfd {
        fd,
        events: libc::POLLHUP,
        revents: 0,
    }
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
            // Poll stdin for input and stdout for closure. A peer that closes
            // its read end of the output pipe is detected here eagerly, not
            // only on the next write, so a disconnect mid-request stops the
            // request instead of letting it run to completion.
            let mut descriptors = [
                libc::pollfd {
                    fd: libc::STDIN_FILENO,
                    events: libc::POLLIN,
                    revents: 0,
                },
                output_descriptor(libc::STDOUT_FILENO),
            ];
            // The backend is the only stdin reader. Read the descriptor directly:
            // a buffered Stdin reader could contain bytes invisible to poll.
            let ready = unsafe {
                libc::poll(
                    descriptors.as_mut_ptr(),
                    descriptors.len() as libc::nfds_t,
                    100,
                )
            };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            // Any event on the stdout descriptor is an error (POLLERR, POLLHUP,
            // or POLLNVAL): the peer can no longer receive a response.
            if descriptors[1].revents != 0 {
                self.failed.store(true, Ordering::Release);
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "output closed"));
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;

    #[test]
    fn output_observer_waits_until_the_pipe_reader_closes() {
        // std's pipe is close-on-exec. A bare libc::pipe would let a child
        // spawned by another test running in parallel inherit the read end
        // and keep the pipe open after `reader` is dropped.
        let (reader, writer) = std::io::pipe().unwrap();
        let mut output = output_descriptor(writer.as_raw_fd());
        assert_eq!(
            unsafe { libc::poll(&mut output, 1, 20) },
            0,
            "a writable pipe must not wake an idle observer"
        );
        drop(reader);
        assert_eq!(unsafe { libc::poll(&mut output, 1, 200) }, 1);
        assert_ne!(
            output.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL),
            0,
            "peer closure must wake the observer without writing a response"
        );
    }
}
