//! The Windows sources: MachineGuid, the system volume's serial, the HKCU anchor, and
//! the hidden attribute on the anchor file.

use std::ffi::c_void;
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{GetLastError, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileAttributesW, GetVolumeInformationW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN,
    INVALID_FILE_ATTRIBUTES,
};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegGetValueW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_QWORD,
    RRF_RT_REG_QWORD, RRF_RT_REG_SZ,
};

/// Read the 64-bit registry view even from a 32-bit process: the 32-bit view has no
/// MachineGuid, and a silently different ID is the worst possible failure here.
const RRF_SUBKEY_WOW6464KEY: u32 = 0x0001_0000;

const ANCHOR_VALUE: &str = "LastSeenAt";

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`.
pub fn machine_guid() -> Result<String, String> {
    let subkey = wide(r"SOFTWARE\Microsoft\Cryptography");
    let value = wide("MachineGuid");
    let mut buffer = [0u16; 128];
    let mut size = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: the buffer and size describe the same allocation, and the strings are
    // NUL-terminated wide strings that outlive the call.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            null_mut(),
            buffer.as_mut_ptr().cast::<c_void>(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("reading MachineGuid failed with Windows error {status}"));
    }
    let chars = (size as usize / 2).saturating_sub(1);
    let guid = String::from_utf16_lossy(&buffer[..chars]).trim().to_string();
    if guid.is_empty() {
        return Err("MachineGuid is empty".to_string());
    }
    Ok(guid)
}

/// The serial of the volume Windows is installed on (`%SystemDrive%`).
pub fn system_volume_serial() -> Result<u32, String> {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    let root = wide(&format!("{}\\", drive.trim_end_matches('\\')));
    let mut serial: u32 = 0;
    // SAFETY: only the serial out-pointer is requested; every other buffer is null
    // with a zero length, which the API documents as allowed.
    let ok = unsafe {
        GetVolumeInformationW(root.as_ptr(), null_mut(), 0, &mut serial, null_mut(), null_mut(), null_mut(), 0)
    };
    if ok == 0 {
        // SAFETY: reads the calling thread's last-error value.
        return Err(format!("reading the volume serial failed with Windows error {}", unsafe { GetLastError() }));
    }
    Ok(serial)
}

/// The anchor under `HKCU\<subkey>`, or `None` when it has never been written.
pub fn read_registry_anchor(subkey: &str) -> Result<Option<i64>, String> {
    let subkey = wide(subkey);
    let value = wide(ANCHOR_VALUE);
    let mut data: u64 = 0;
    let mut size = std::mem::size_of::<u64>() as u32;
    // SAFETY: `data` is eight bytes and `size` says so.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_QWORD,
            null_mut(),
            (&mut data as *mut u64).cast::<c_void>(),
            &mut size,
        )
    };
    match status {
        ERROR_SUCCESS => Ok(Some(data as i64)),
        ERROR_FILE_NOT_FOUND => Ok(None),
        other => Err(format!("reading HKCU anchor failed with Windows error {other}")),
    }
}

/// Writes the anchor under `HKCU\<subkey>`, creating the key if needed.
pub fn write_registry_anchor(subkey: &str, value: i64) -> Result<(), String> {
    let subkey = wide(subkey);
    let name = wide(ANCHOR_VALUE);
    let mut key: HKEY = null_mut();
    // SAFETY: standard create-or-open; `key` receives a handle closed below.
    let created = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            null(),
            &mut key,
            null_mut(),
        )
    };
    if created != ERROR_SUCCESS {
        return Err(format!("opening HKCU anchor key failed with Windows error {created}"));
    }
    let bytes = (value as u64).to_le_bytes();
    // SAFETY: `key` is open with KEY_SET_VALUE; the data pointer covers eight bytes.
    let set = unsafe { RegSetValueExW(key, name.as_ptr(), 0, REG_QWORD, bytes.as_ptr(), bytes.len() as u32) };
    // SAFETY: closes the handle opened above.
    unsafe { RegCloseKey(key) };
    if set != ERROR_SUCCESS {
        return Err(format!("writing HKCU anchor failed with Windows error {set}"));
    }
    Ok(())
}

/// Removes `HKCU\<subkey>` and everything under it. For test cleanup only.
pub fn delete_registry_key(subkey: &str) -> Result<(), String> {
    let subkey = wide(subkey);
    // SAFETY: deletes a subtree of the current user's hive by name.
    let status = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, subkey.as_ptr()) };
    match status {
        ERROR_SUCCESS | ERROR_FILE_NOT_FOUND => Ok(()),
        other => Err(format!("deleting HKCU key failed with Windows error {other}")),
    }
}

/// Sets the hidden attribute, keeping the others.
pub fn set_hidden(path: &Path) -> std::io::Result<()> {
    let wide_path = wide(&path.to_string_lossy());
    // SAFETY: a NUL-terminated path that outlives both calls.
    unsafe {
        let current = GetFileAttributesW(wide_path.as_ptr());
        if current == INVALID_FILE_ATTRIBUTES {
            return Err(std::io::Error::last_os_error());
        }
        if SetFileAttributesW(wide_path.as_ptr(), current | FILE_ATTRIBUTE_HIDDEN) == 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_this_machines_sources() {
        let guid = machine_guid().expect("MachineGuid is readable by any user");
        assert!(guid.len() >= 32, "{guid}");
        system_volume_serial().expect("the system volume has a serial");
    }

    #[test]
    fn the_registry_anchor_round_trips() {
        let subkey = format!(r"Software\Walaa-Test-{}", std::process::id());
        assert_eq!(read_registry_anchor(&subkey).unwrap(), None);
        write_registry_anchor(&subkey, 1_800_000_000).unwrap();
        assert_eq!(read_registry_anchor(&subkey).unwrap(), Some(1_800_000_000));
        delete_registry_key(&subkey).unwrap();
        assert_eq!(read_registry_anchor(&subkey).unwrap(), None);
    }
}
