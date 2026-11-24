//! Kleine Registry-Helfer (nur Windows), ohne zusätzliches Crate.
//!
//! Gebraucht für:
//! * IP-Profile: lesen, ob DNS fest eingetragen ist (HKLM, nur lesen)
//! * Autostart: Wert unter HKCU\Software\Microsoft\Windows\CurrentVersion\Run
//!   (HKCU = nur der aktuelle Benutzer, braucht keine Adminrechte)

use std::ffi::c_void;
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ, RRF_RT_REG_SZ,
};

#[derive(Debug, Clone, Copy)]
pub enum Root {
    CurrentUser,
    LocalMachine,
}

/// Rust-String → nullterminierter UTF-16-String.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Geöffneter Schlüssel – wird beim Verlassen automatisch geschlossen.
struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: Der Handle stammt von RegOpenKeyExW und wird genau einmal geschlossen.
        unsafe {
            RegCloseKey(self.0);
        }
    }
}

fn open(root: Root, path: &str, access: u32) -> Result<Key, String> {
    let root = match root {
        Root::CurrentUser => HKEY_CURRENT_USER,
        Root::LocalMachine => HKEY_LOCAL_MACHINE,
    };
    let path_w = wide(path);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: path_w ist nullterminiert und lebt bis nach dem Aufruf; key wird beschrieben.
    let r = unsafe { RegOpenKeyExW(root, path_w.as_ptr(), 0, access, &mut key) };
    if r != ERROR_SUCCESS {
        return Err(format!("Registry-Schlüssel nicht lesbar (Fehler {r})."));
    }
    Ok(Key(key))
}

/// Zeichenkette lesen. Ok(None) = Wert existiert nicht.
pub fn read_string(root: Root, path: &str, value: &str) -> Result<Option<String>, String> {
    let key = open(root, path, KEY_QUERY_VALUE)?;
    let name = wide(value);
    let mut size: u32 = 0;
    // SAFETY: Erster Aufruf ohne Puffer fragt nur die Grösse in Bytes ab.
    let r = unsafe {
        RegGetValueW(key.0, std::ptr::null(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut size)
    };
    if r == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if r != ERROR_SUCCESS {
        return Err(format!("Registry-Wert nicht lesbar (Fehler {r})."));
    }
    // +1 Reserve, falls der Wert zwischen den Aufrufen wächst (dann Fehler statt Überlauf)
    let mut buf = vec![0u16; size as usize / 2 + 1];
    let mut bytes = (buf.len() * 2) as u32;
    // SAFETY: buf ist `bytes` Bytes gross; RegGetValueW schreibt höchstens so viel.
    let r = unsafe {
        RegGetValueW(
            key.0,
            std::ptr::null(),
            name.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr() as *mut c_void,
            &mut bytes,
        )
    };
    if r != ERROR_SUCCESS {
        return Err(format!("Registry-Wert nicht lesbar (Fehler {r})."));
    }
    let len = (bytes as usize / 2).min(buf.len());
    let text = &buf[..len];
    let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
    Ok(Some(String::from_utf16_lossy(&text[..end])))
}

/// Zeichenkette (REG_SZ) schreiben. Der Schlüssel muss existieren (Run tut das immer).
pub fn set_string(root: Root, path: &str, value: &str, data: &str) -> Result<(), String> {
    let key = open(root, path, KEY_SET_VALUE)?;
    let name = wide(value);
    let data_w = wide(data);
    let bytes = (data_w.len() * 2) as u32; // inkl. abschliessender Null, wie verlangt
    // SAFETY: data_w lebt bis nach dem Aufruf, `bytes` passt zur Länge.
    let r = unsafe { RegSetValueExW(key.0, name.as_ptr(), 0, REG_SZ, data_w.as_ptr() as *const u8, bytes) };
    if r != ERROR_SUCCESS {
        return Err(format!("Registry-Wert konnte nicht geschrieben werden (Fehler {r})."));
    }
    Ok(())
}

/// Wert löschen. Gibt es ihn nicht, ist das kein Fehler.
pub fn delete_value(root: Root, path: &str, value: &str) -> Result<(), String> {
    let key = open(root, path, KEY_SET_VALUE)?;
    let name = wide(value);
    // SAFETY: name ist nullterminiert.
    let r = unsafe { RegDeleteValueW(key.0, name.as_ptr()) };
    if r != ERROR_SUCCESS && r != ERROR_FILE_NOT_FOUND {
        return Err(format!("Registry-Wert konnte nicht gelöscht werden (Fehler {r})."));
    }
    Ok(())
}
