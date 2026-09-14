//! The code a merchant pastes: `base64url(payload) + "." + base64url(signature)`,
//! sent as 60-character lines so it survives WhatsApp.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

/// Characters per line when a code is printed for sending.
pub const LINE_WIDTH: usize = 60;

/// The longest payload accepted. A real one is a few hundred bytes.
const MAX_PAYLOAD_BYTES: usize = 4096;

/// What a pasted code is reduced to before anything reads it.
///
/// All whitespace goes — spaces, tabs, line breaks, no-break spaces — and so do the
/// invisible direction and zero-width marks that chat apps insert around Latin text in
/// an Arabic conversation. A code copied out of a right-to-left WhatsApp chat arrives
/// with those marks in it, and they are not part of any valid code.
pub fn normalize(input: &str) -> String {
    input
        .chars()
        .filter(|c| !c.is_whitespace() && !is_invisible_mark(*c))
        .collect()
}

fn is_invisible_mark(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' // zero-width space/joiners, LRM, RLM
            | '\u{202A}'..='\u{202E}' // embeddings and overrides
            | '\u{2060}'..='\u{2069}' // word joiner, isolates
            | '\u{FEFF}' // byte-order mark
    )
}

/// The code for a payload and its signature, on one line.
pub fn encode(payload: &[u8], signature: &[u8; 64]) -> String {
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(payload),
        URL_SAFE_NO_PAD.encode(signature)
    )
}

/// The code split into 60-character lines, for sending.
pub fn wrap(code: &str) -> String {
    code.as_bytes()
        .chunks(LINE_WIDTH)
        .map(|chunk| std::str::from_utf8(chunk).expect("a code is ASCII"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The two halves of a code.
pub struct Parts {
    pub payload: Vec<u8>,
    pub signature: [u8; 64],
}

/// Splits and decodes a normalized code. `None` for anything that is not the format.
pub fn decode(normalized: &str) -> Option<Parts> {
    let (payload_part, signature_part) = normalized.split_once('.')?;
    if payload_part.is_empty() || signature_part.is_empty() || signature_part.contains('.') {
        return None;
    }
    // Padding is not part of the format, but a hand-tidied code may carry it.
    let payload = URL_SAFE_NO_PAD.decode(payload_part.trim_end_matches('=')).ok()?;
    let signature = URL_SAFE_NO_PAD.decode(signature_part.trim_end_matches('=')).ok()?;
    if payload.is_empty() || payload.len() > MAX_PAYLOAD_BYTES {
        return None;
    }
    Some(Parts {
        payload,
        signature: signature.try_into().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapping_and_normalizing_are_inverse() {
        let code = format!("{}.{}", "a".repeat(130), "b".repeat(86));
        let wrapped = wrap(&code);
        assert!(wrapped.lines().all(|line| line.len() <= LINE_WIDTH));
        assert_eq!(wrapped.lines().count(), 4);
        assert_eq!(normalize(&wrapped), code);
    }

    #[test]
    fn strips_the_marks_a_right_to_left_chat_adds() {
        let pasted = "\u{200F}\u{202A}abc\u{2069}.\u{200E}d e\u{00A0}f\u{FEFF}\r\n";
        assert_eq!(normalize(pasted), "abc.def");
    }

    #[test]
    fn refuses_what_is_not_the_format() {
        assert!(decode("no-dot-here").is_none());
        assert!(decode("a.b.c").is_none());
        assert!(decode(".abc").is_none());
        assert!(decode("abc.").is_none());
        assert!(decode("!!!.abc").is_none());
        // A signature that is not 64 bytes.
        let short = format!("{}.{}", URL_SAFE_NO_PAD.encode(b"{}"), URL_SAFE_NO_PAD.encode([0u8; 10]));
        assert!(decode(&short).is_none());
    }
}
