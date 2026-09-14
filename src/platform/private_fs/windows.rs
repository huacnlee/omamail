//! All descendant opens are relative to a checked directory handle. Win32 path
//! parsing (DOS aliases, ADS, junctions and device paths) never sees a child name.
use crate::platform::windows_security as security;
use std::{
    ffi::OsStr,
    fs::{File, Metadata},
    io::Write,
    mem::offset_of,
    os::windows::{
        ffi::OsStrExt,
        fs::MetadataExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
    ptr,
    sync::atomic::{AtomicU64, Ordering},
};
use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as nt},
    Win32::{Foundation::*, Storage::FileSystem::*, System::IO::IO_STATUS_BLOCK},
};
type Result<T> = std::result::Result<T, &'static str>;
static SERIAL: AtomicU64 = AtomicU64::new(0);
static REPLACEMENTS: std::sync::RwLock<()> = std::sync::RwLock::new(());
static ENUMERATIONS: std::sync::Mutex<()> = std::sync::Mutex::new(());
const SHARE: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const READ: u32 = FILE_GENERIC_READ;

fn name_units(name: &OsStr) -> Result<Vec<u16>> {
    let units: Vec<_> = name.encode_wide().collect();
    let text = name.to_str().ok_or("cache_invalid_input")?;
    let stem = text.split('.').next().unwrap_or("").to_ascii_uppercase();
    if units.is_empty()
        || units.len() > 255
        || text == "."
        || text == ".."
        || text.ends_with(['.', ' '])
        || text.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*')
        })
        || matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
        || (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9')
    {
        return Err("cache_invalid_input");
    }
    Ok(units)
}

/// Only local drive roots are accepted. UNC/device namespaces and reparse-backed
/// cloud folders are refused; they require a different, explicitly reviewed policy.
fn path_parts(path: &Path) -> Result<(Vec<u16>, Vec<&OsStr>)> {
    if !path.is_absolute() {
        return Err("cache_home_invalid");
    }
    let mut components = path.components();
    let drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return Err("cache_home_invalid"),
        },
        _ => return Err("cache_home_invalid"),
    };
    if components.next() != Some(Component::RootDir) {
        return Err("cache_home_invalid");
    }
    let mut names = Vec::new();
    for component in components {
        let Component::Normal(name) = component else {
            return Err("cache_home_invalid");
        };
        name_units(name)?;
        names.push(name);
    }
    // Path::components normalizes interior '.'; reject that spelling as well.
    if path
        .as_os_str()
        .to_string_lossy()
        .split(['/', '\\'])
        .any(|part| part == "." || part == "..")
    {
        return Err("cache_home_invalid");
    }
    Ok((
        format!("\\\\?\\{}:\\", drive as char)
            .encode_utf16()
            .chain(Some(0))
            .collect(),
        names,
    ))
}
fn drive_root(path: &[u16]) -> Result<File> {
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            READ,
            SHARE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err("cache_unavailable");
    }
    let file = unsafe { File::from_raw_handle(handle) };
    check_kind(&file, true)?;
    let mut flags = 0;
    if unsafe {
        GetVolumeInformationByHandleW(
            handle,
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut flags,
            ptr::null_mut(),
            0,
        )
    } == 0
        || flags & 0x00000008 /* FILE_PERSISTENT_ACLS */ == 0
    {
        return Err("cache_unsafe_path");
    }
    security::validate(handle, false)?;
    Ok(file)
}

pub(crate) fn final_path(file: &File) -> Result<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("cache_unsafe_path");
    }
    use std::os::windows::ffi::OsStringExt;
    Ok(std::ffi::OsString::from_wide(&buffer[..length]).into())
}
fn check_child(parent: &File, child: &File) -> Result<()> {
    // Handles are authoritative. This is an additional containment assertion,
    // never a path used for a subsequent open/write/delete. Rename races refuse.
    if final_path(child)?.parent() != Some(final_path(parent)?.as_path()) {
        return Err("cache_unsafe_path");
    }
    Ok(())
}
fn check_kind(file: &File, directory: bool) -> Result<()> {
    let metadata = file.metadata().map_err(|_| "cache_unavailable")?;
    if metadata.file_attributes() & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE) != 0
        || metadata.is_dir() != directory
        || (!directory && (!metadata.is_file() || file_id(file)?.2 != 1))
    {
        return Err("cache_unsafe_path");
    }
    Ok(())
}
/// Stable volume/file identity is also the pipe namespace key, so long and
/// Unicode paths, aliases and renamed ancestors do not change endpoint identity.
pub(crate) fn file_id(file: &File) -> Result<(u32, u64, u32)> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err("cache_unavailable");
    }
    Ok((
        info.dwVolumeSerialNumber,
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        info.nNumberOfLinks,
    ))
}

fn open_at(
    parent: &File,
    name: &OsStr,
    directory: bool,
    disposition: u32,
    access: u32,
    share: u32,
) -> Result<Option<File>> {
    let mut units = name_units(name)?;
    let mut unicode = UNICODE_STRING {
        Length: (units.len() * 2) as u16,
        MaximumLength: (units.len() * 2) as u16,
        Buffer: units.as_mut_ptr(),
    };
    let descriptor = security::private_descriptor()?;
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &mut unicode,
        Attributes: 0x40 | 0x1000, // OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE; no OBJ_INHERIT.
        SecurityDescriptor: descriptor.0.cast(),
        SecurityQualityOfService: ptr::null_mut(),
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut handle = ptr::null_mut();
    let result = unsafe {
        nt::NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE,
            &attributes,
            &mut status,
            ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            share,
            disposition,
            nt::FILE_OPEN_REPARSE_POINT
                | nt::FILE_SYNCHRONOUS_IO_NONALERT
                | if directory {
                    nt::FILE_DIRECTORY_FILE
                } else {
                    nt::FILE_NON_DIRECTORY_FILE
                }
                | if access & FILE_WRITE_DATA != 0 && !directory {
                    nt::FILE_WRITE_THROUGH
                } else {
                    0
                },
            ptr::null(),
            0,
        )
    };
    if result < 0 {
        return match result as u32 {
            0xc0000034 | 0xc000003a | 0xc0000056 => Ok(None), // NAME/PATH_NOT_FOUND or DELETE_PENDING.
            0xc0000035 => Err("private_fs_exists"),
            0xc0000043 => Err("private_fs_busy"),
            _ => Err("cache_unsafe_path"),
        };
    }
    let file = unsafe { File::from_raw_handle(handle) };
    if !directory && file_id(&file)?.2 == 0 {
        return Ok(None);
    }
    check_kind(&file, directory)?;
    check_child(parent, &file)?;
    Ok(Some(file))
}

pub(crate) fn open_dir(
    parent: &File,
    name: &OsStr,
    create: bool,
    private: bool,
) -> Result<Option<File>> {
    open_directory(parent, name, create, private, private)
}
fn open_directory(
    parent: &File,
    name: &OsStr,
    create: bool,
    private: bool,
    writable: bool,
) -> Result<Option<File>> {
    // Mutation consumers flush directory metadata after replacing/removing cache
    // entries. FlushFileBuffers requires GENERIC_WRITE; traversal and explicit
    // readonly calls retain only read access.
    let Some(file) = open_at(
        parent,
        name,
        true,
        if create {
            nt::FILE_OPEN_IF
        } else {
            nt::FILE_OPEN
        },
        READ | if writable { FILE_GENERIC_WRITE } else { 0 },
        SHARE,
    )?
    else {
        return Ok(None);
    };
    security::validate(file.as_raw_handle(), private)?;
    Ok(Some(file))
}
pub(crate) fn directories(root: &Path, suffix: &[&str], create: bool) -> Result<Option<File>> {
    walk_directories(root, suffix, create, false)
}
fn walk_directories(
    root: &Path,
    suffix: &[&str],
    create: bool,
    readonly: bool,
) -> Result<Option<File>> {
    let (drive, components) = path_parts(root)?;
    // Validate the whole input before creation can have any side effect.
    for name in suffix {
        name_units(name.as_ref())?;
    }
    let mut parent = drive_root(&drive)?;
    for name in components {
        let Some(next) = open_dir(&parent, name, create, false)? else {
            return Ok(None);
        };
        parent = next;
    }
    for name in suffix {
        let Some(next) = open_directory(&parent, name.as_ref(), create, true, !readonly)? else {
            return Ok(None);
        };
        parent = next;
    }
    Ok(Some(parent))
}
pub(crate) fn directories_readonly(root: &Path, suffix: &[&str]) -> Result<Option<File>> {
    walk_directories(root, suffix, false, true)
}
pub(crate) fn validate_owned_root(dir: &File) -> Result<()> {
    check_kind(dir, true)?;
    security::validate(dir.as_raw_handle(), true)
}
pub(crate) fn open_private(dir: &File, name: &str, writable: bool) -> Result<Option<File>> {
    regular_with_access(
        dir,
        name,
        READ | FILE_WRITE_ATTRIBUTES | if writable { FILE_GENERIC_WRITE } else { 0 },
    )
}
fn regular_with_access(dir: &File, name: &str, access: u32) -> Result<Option<File>> {
    // Keep validation of an opened name outside our own replacement's brief
    // rename/delete transition. The returned handle remains authoritative and
    // usable after the guard is released, including when its name is replaced.
    let _replacement = REPLACEMENTS.read().map_err(|_| "cache_unavailable")?;
    regular_with_access_unlocked(dir, name, access)
}
fn regular_with_access_unlocked(dir: &File, name: &str, access: u32) -> Result<Option<File>> {
    validate_owned_root(dir)?;
    let Some(file) = open_at(dir, name.as_ref(), false, nt::FILE_OPEN, access, SHARE)? else {
        return Ok(None);
    };
    security::validate(file.as_raw_handle(), true)?;
    Ok(Some(file))
}
pub(crate) use open_private as regular;
pub(crate) fn regular_readonly(dir: &File, name: &str) -> Result<Option<File>> {
    regular_with_access(dir, name, READ)
}

fn delete_handle(file: &File) -> Result<()> {
    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&info as *const FILE_DISPOSITION_INFO).cast(),
            size_of_val(&info) as u32,
        )
    } == 0
    {
        return Err("cache_unavailable");
    }
    Ok(())
}
pub(crate) fn remove_owned(dir: &File, name: &str) -> Result<()> {
    validate_owned_root(dir)?;
    // Delete the very handle whose type/link count/ACL we checked, never a name
    // looked up a second time after the check.
    let Some(file) = open_at(
        dir,
        name.as_ref(),
        false,
        nt::FILE_OPEN,
        READ | DELETE,
        SHARE,
    )?
    else {
        return Ok(());
    };
    security::validate(file.as_raw_handle(), true)?;
    delete_handle(&file)
}
pub(crate) fn create_private(dir: &File, name: &str) -> Result<File> {
    let file = open_at(
        dir,
        name.as_ref(),
        false,
        nt::FILE_CREATE,
        READ | FILE_GENERIC_WRITE | DELETE,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
    )?
    .ok_or("cache_unavailable")?;
    security::validate(file.as_raw_handle(), true)?;
    Ok(file)
}
pub(crate) fn atomic_replace(dir: &File, name: &str, bytes: &[u8]) -> Result<()> {
    // Windows replacement briefly transitions the destination through a
    // delete-pending name. Serialize our writers so one validated replacement
    // cannot observe another operation's transient namespace state.
    let _replacement = REPLACEMENTS.write().map_err(|_| "cache_unavailable")?;
    validate_owned_root(dir)?;
    regular_with_access_unlocked(dir, name, READ)?;
    let name = name_units(name.as_ref())?;
    let temporary = format!(
        ".tmp.{}.{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    );
    let mut file = create_private(dir, &temporary)?;
    let mut renamed = false;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "cache_unavailable")?;
        let target = String::from_utf16(&name).map_err(|_| "cache_invalid_input")?;
        regular_with_access_unlocked(dir, &target, READ)?;
        let offset = offset_of!(nt::FILE_RENAME_INFORMATION, FileName);
        let length = (offset + name.len() * 2).max(size_of::<nt::FILE_RENAME_INFORMATION>());
        let mut buffer = vec![0usize; length.div_ceil(size_of::<usize>())];
        let info = buffer.as_mut_ptr().cast::<nt::FILE_RENAME_INFORMATION>();
        // Native rename supports RootDirectory; Win32 FILE_RENAME_INFO does not.
        unsafe {
            (*info).Anonymous.Flags =
                nt::FILE_RENAME_REPLACE_IF_EXISTS | nt::FILE_RENAME_POSIX_SEMANTICS;
            (*info).RootDirectory = dir.as_raw_handle();
            (*info).FileNameLength = (name.len() * 2) as u32;
            ptr::copy_nonoverlapping(
                name.as_ptr(),
                buffer.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
                name.len(),
            );
        }
        let mut status = IO_STATUS_BLOCK::default();
        if unsafe {
            nt::NtSetInformationFile(
                file.as_raw_handle(),
                &mut status,
                buffer.as_ptr().cast(),
                length as u32,
                nt::FileRenameInformationEx,
            )
        } < 0
        {
            return Err("cache_unavailable");
        }
        renamed = true;
        // FlushFileBuffers runs both before and after rename, through the same
        // file handle. Power-loss durability still needs native filesystem tests.
        file.sync_all().map_err(|_| "cache_unavailable")
    })();
    if result.is_err() && !renamed {
        let _ = delete_handle(&file);
    }
    result
}

/// Windows has no supported equivalent of fsync(2) for a directory handle.
/// Each file replacement is flushed before and after its rename above.
pub(crate) fn sync_dir(_: &File) -> Result<()> {
    Ok(())
}

pub(crate) struct ExclusiveLock {
    _file: File,
}
pub(crate) fn lock_exclusive(dir: &File, name: &str) -> Result<ExclusiveLock> {
    validate_owned_root(dir)?;
    let file = open_at(
        dir,
        name.as_ref(),
        false,
        nt::FILE_OPEN_IF,
        READ | FILE_GENERIC_WRITE,
        0,
    )?
    .ok_or("cache_unavailable")?;
    security::validate(file.as_raw_handle(), true)?;
    // A non-inheritable handle with share=0 is the lease. No PID files, stale
    // cleanup, or path-based deletion; Windows releases it when the owner dies.
    Ok(ExclusiveLock { _file: file })
}

pub(crate) fn names(dir: &File) -> Result<Vec<String>> {
    validate_owned_root(dir)?;
    // Restart the cursor on the already pinned and validated handle. ReOpenFile
    // does not reliably accept directory handles on all supported Windows
    // filesystems; serializing prevents two restarts from sharing a cursor.
    let _enumeration = ENUMERATIONS.lock().map_err(|_| "cache_unavailable")?;
    let mut buffer = vec![0u64; 8192];
    let capacity = buffer.len() * size_of::<u64>();
    let mut out = Vec::new();
    let mut first = true;
    loop {
        let mut status = IO_STATUS_BLOCK::default();
        let result = unsafe {
            nt::NtQueryDirectoryFile(
                dir.as_raw_handle(),
                ptr::null_mut(),
                None,
                ptr::null(),
                &mut status,
                buffer.as_mut_ptr().cast(),
                capacity as u32,
                nt::FileIdBothDirectoryInformation,
                false,
                ptr::null(),
                first,
            )
        };
        if result < 0 {
            return if result as u32 == 0x80000006 {
                Ok(out)
            } else {
                Err("cache_unavailable")
            };
        }
        first = false;
        let mut offset = 0;
        loop {
            let name_offset = offset_of!(nt::FILE_ID_BOTH_DIR_INFORMATION, FileName);
            if offset + size_of::<nt::FILE_ID_BOTH_DIR_INFORMATION>() > capacity {
                return Err("cache_unsafe_path");
            }
            let info = unsafe {
                &*buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<nt::FILE_ID_BOTH_DIR_INFORMATION>()
            };
            let length = info.FileNameLength as usize;
            if length % 2 != 0 || length > 510 || offset + name_offset + length > capacity {
                return Err("cache_unsafe_path");
            }
            let name = String::from_utf16(unsafe {
                std::slice::from_raw_parts(
                    buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset + name_offset)
                        .cast::<u16>(),
                    length / 2,
                )
            })
            .map_err(|_| "cache_unsafe_path")?;
            if name != "." && name != ".." {
                name_units(name.as_ref())?;
                out.push(name);
            }
            if out.len() > 10000 {
                return Err("cache_too_many_files");
            }
            if info.NextEntryOffset == 0 {
                break;
            }
            let next = info.NextEntryOffset as usize;
            if next < name_offset + length || next % 8 != 0 {
                return Err("cache_unsafe_path");
            }
            offset = offset.checked_add(next).ok_or("cache_unsafe_path")?;
        }
    }
}
pub(crate) fn open_external(path: &Path) -> Result<File> {
    let (drive, names) = path_parts(path).map_err(|_| "mail_send_attachment_path")?;
    let (last, parents) = names.split_last().ok_or("mail_send_attachment_path")?;
    let mut dir = drive_root(&drive)?;
    // Attachments may be intentionally shared: only containment, regular-file
    // shape and reparse refusal apply, without imposing a private-data DACL.
    for name in parents {
        dir = open_at(&dir, name, true, nt::FILE_OPEN, READ, SHARE)?
            .ok_or("mail_send_attachment_unreadable")?;
    }
    open_at(&dir, last, false, nt::FILE_OPEN, READ, FILE_SHARE_READ)?
        .ok_or("mail_send_attachment_unreadable")
}
pub(crate) fn same_file_version(before: &Metadata, after: &Metadata) -> bool {
    (
        before.creation_time(),
        before.last_write_time(),
        before.file_size(),
        before.file_attributes(),
    ) == (
        after.creation_time(),
        after.last_write_time(),
        after.file_size(),
        after.file_attributes(),
    )
}

pub(crate) fn write_unique(dir: &File, filename: &str, bytes: &[u8]) -> Result<PathBuf> {
    check_kind(dir, true)?;
    security::validate(dir.as_raw_handle(), false)?;
    name_units(filename.as_ref())?;
    let path = Path::new(filename);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let suffix = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for index in 1..1000 {
        let name = if index == 1 {
            filename.to_owned()
        } else {
            format!("{stem} ({index}){suffix}")
        };
        let mut file = match create_private(dir, &name) {
            Ok(file) => file,
            Err("private_fs_exists") => continue,
            Err(error) => return Err(error),
        };
        if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
            let _ = delete_handle(&file);
            return Err("cache_unavailable");
        }
        return final_path(&file);
    }
    Err("cache_unavailable")
}
