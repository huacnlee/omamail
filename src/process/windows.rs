//! Windows process trees are jobs, with children suspended until assignment.
use super::Error;
use std::os::windows::{
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt,
};
use std::process::Command;
use std::time::Duration;
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
        Threading::{
            CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
        },
    },
};

pub(super) fn configure(command: &mut Command) {
    command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
}

pub(super) struct Tree(OwnedHandle);
impl Tree {
    pub(super) fn for_child(child: &std::process::Child) -> Result<Self, Error> {
        Self::attach(child.id(), child.as_raw_handle())
    }
    pub(super) fn for_async_child(child: &tokio::process::Child) -> Result<Self, Error> {
        Self::attach(
            child.id().ok_or("process_unavailable")?,
            child.raw_handle().ok_or("process_unavailable")?,
        )
    }
    fn attach(pid: u32, process: HANDLE) -> Result<Self, Error> {
        // The job handle is non-inheritable and breakaway is never enabled.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err("process_job_failed");
        }
        let tree = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                tree.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err("process_job_failed");
        }
        if unsafe { AssignProcessToJobObject(tree.0.as_raw_handle(), process) } == 0 {
            return Err("process_job_failed");
        }
        // std::process owns the process handle but does not expose the primary
        // thread handle. The suspended process cannot run or create more threads;
        // find its initial thread using the documented Tool Help API.
        resume(pid)?;
        Ok(tree)
    }
    pub(super) fn terminate(&self) -> Result<(), Error> {
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
            Err("process_termination_failed")
        } else {
            Ok(())
        }
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}
fn resume(pid: u32) -> Result<(), Error> {
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err("process_resume_failed");
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            let raw = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if raw.is_null() {
                return Err("process_resume_failed");
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err("process_resume_failed");
            }
            return Ok(());
        }
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    Err("process_resume_failed")
}

pub(super) fn run(
    program: &str,
    args: &[String],
    input: &[u8],
    timeout: Duration,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    if input.len() > limit {
        return Err("process_input_too_large");
    }
    // Tokio drains Windows pipes on its blocking pool. The non-breakaway job
    // closes every inherited child handle on timeout, allowing those workers
    // to finish. A scoped runtime also permits calls from an existing runtime.
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| "process_unavailable")?;
                let output = runtime.block_on(super::async_run::run_with_stderr_limit(
                    program, args, input, timeout, limit, limit,
                ))?;
                if output.success {
                    Ok(output.stdout)
                } else {
                    Err("process_failed")
                }
            })
            .join()
            .map_err(|_| "process_wait_failed")?
    })
}
