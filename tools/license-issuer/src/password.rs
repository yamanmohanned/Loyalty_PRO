//! The key's password — the same characters however it reached the program.
//!
//! It has failed twice for reasons that had nothing to do with the password. The key was
//! first sealed with an invisible U+FEFF in front of it, because the shell that ran keygen
//! piped a byte-order mark into standard input; then, after it was re-sealed without one,
//! a wrapper written to add that mark corrupted a correct password into «wrong password,
//! or the key file is damaged». Every way in — typed, piped from any shell, read from a
//! file — now goes through [`normalize`], at sealing and at opening alike, so no wrapper
//! is ever needed and no shell can change what the key is sealed under.
//!
//! What it removes can never be a deliberate part of a password: a byte-order mark
//! anywhere, and at either end whitespace, line endings and the invisible direction and
//! zero-width marks message apps and editors insert. Spaces *inside* a password are kept.

/// Characters with no visible form that shells, editors and message apps put around text.
const INVISIBLE: &[char] = &[
    '\u{FEFF}', // byte-order mark / zero-width no-break space
    '\u{200B}', // zero-width space
    '\u{200C}', // zero-width non-joiner
    '\u{200D}', // zero-width joiner
    '\u{200E}', // left-to-right mark
    '\u{200F}', // right-to-left mark
    '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', // bidi embeddings and overrides
    '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}', // bidi isolates
];

fn is_padding(c: char) -> bool {
    c.is_whitespace() || INVISIBLE.contains(&c)
}

/// Decodes raw bytes as text: UTF-8, or UTF-16 when a byte-order mark (or the shape of
/// ASCII written as UTF-16LE, which is what Windows PowerShell 5.1's `>` produces) says so.
fn decode(raw: &[u8]) -> Result<String, String> {
    let unreadable = || "the password is not readable text — save it as plain UTF-8 or UTF-16".to_string();
    let utf16 = |bytes: &[u8], little: bool| -> Result<String, String> {
        if bytes.len() % 2 != 0 {
            return Err(unreadable());
        }
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| if little { u16::from_le_bytes([pair[0], pair[1]]) } else { u16::from_be_bytes([pair[0], pair[1]]) })
            .collect();
        String::from_utf16(&units).map_err(|_| unreadable())
    };

    if let Some(rest) = raw.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, true);
    }
    if let Some(rest) = raw.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, false);
    }
    let looks_utf16le = raw.len() >= 2
        && raw.len() % 2 == 0
        && raw.iter().skip(1).step_by(2).all(|&b| b == 0)
        && raw.iter().step_by(2).any(|&b| b != 0);
    if looks_utf16le {
        return utf16(raw, true);
    }
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    String::from_utf8(raw.to_vec()).map_err(|_| unreadable())
}

/// The password as it will be used, from the bytes as they arrived.
pub fn normalize(raw: &[u8]) -> Result<String, String> {
    let text = decode(raw)?;
    let without_marks: String = text.chars().filter(|&c| c != '\u{FEFF}').collect();
    let trimmed = without_marks.trim_matches(is_padding);
    if trimmed.is_empty() {
        return Err("the password is empty".into());
    }
    if trimmed.contains(['\r', '\n']) {
        return Err("the password spans more than one line — the password file must hold the password alone".into());
    }
    Ok(trimmed.to_string())
}

/// The form a key sealed before 2026-09-15 needs: the password behind an invisible U+FEFF,
/// which is how the shell that ran keygen delivered it. Tried only after the plain form
/// fails, so the pre-reseal backup of the key folder stays usable without any wrapper.
pub fn legacy_bom_form(password: &str) -> String {
    format!("\u{FEFF}{password}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "correct horse battery";

    fn utf16le(text: &str, bom: bool) -> Vec<u8> {
        let mut bytes = if bom { vec![0xFF, 0xFE] } else { Vec::new() };
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        bytes
    }

    #[test]
    fn every_shell_delivers_the_same_password() {
        let arrivals: Vec<(&str, Vec<u8>)> = vec![
            ("plain", PASSWORD.as_bytes().to_vec()),
            ("cmd echo, CRLF", format!("{PASSWORD}\r\n").into_bytes()),
            ("bash, LF", format!("{PASSWORD}\n").into_bytes()),
            ("PowerShell with a UTF-8 BOM", [&[0xEF, 0xBB, 0xBF][..], format!("{PASSWORD}\r\n").as_bytes()].concat()),
            ("a BOM decoded into the text", format!("\u{FEFF}{PASSWORD}\r\n").into_bytes()),
            ("two BOMs from two wrappers", format!("\u{FEFF}\u{FEFF}{PASSWORD}").into_bytes()),
            ("PowerShell 5.1 `>` file, UTF-16LE with BOM", utf16le(&format!("{PASSWORD}\r\n"), true)),
            ("UTF-16LE without BOM", utf16le(PASSWORD, false)),
            ("UTF-16BE with BOM", [vec![0xFE, 0xFF], PASSWORD.encode_utf16().flat_map(u16::to_be_bytes).collect()].concat()),
            ("spaces and tabs around it", format!("  \t{PASSWORD} \t ").into_bytes()),
            ("no-break space and direction marks from a message app", format!("\u{200F}\u{00A0}{PASSWORD}\u{200E}\u{200B}").into_bytes()),
        ];
        for (how, bytes) in arrivals {
            assert_eq!(normalize(&bytes).as_deref(), Ok(PASSWORD), "{how}");
        }
    }

    #[test]
    fn spaces_inside_the_password_are_kept() {
        assert_eq!(normalize(b"a b  c").unwrap(), "a b  c");
    }

    #[test]
    fn refuses_what_is_not_a_single_password() {
        assert!(normalize(b"").is_err());
        assert!(normalize(b" \r\n\xEF\xBB\xBF").is_err());
        assert!(normalize(b"first line\r\nsecond line").is_err());
        assert!(normalize(&[0xC3, 0x28, 0x41, 0x42]).is_err());
    }
}
