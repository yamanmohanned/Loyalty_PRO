//! Emergency unlock codes — fifteen symbols the provider reads to a merchant over the
//! phone, which restore full operation at once, with no internet and no visit.
//!
//! ## Why they exist
//!
//! The failure this product must never have is a shop that paid and cannot trade: a
//! corrupted licence, a lost clock record, a Windows reinstall that moved the device ID,
//! a bug in the gate. A licence code fixes all of those, but it is ~300 characters and
//! travels by message. This is the path that works when nothing can be pasted.
//!
//! ## How a short code is checked with nothing secret in the program
//!
//! A signature is 64 bytes — far too long to read aloud. So the codes come from a hash
//! chain. At `keygen` the issuer derives a secret from its private key and hashes it
//! forward `length` times; only the last value, the *tip*, is compiled into the
//! program. The code for day `d` is the value `d` steps before the tip. The program
//! hashes a typed code forward: if the tip turns up after `k` steps, the code is
//! genuine and was issued for day `k`. Producing the code for a later day means
//! inverting the hash, which only the holder of the secret can avoid.
//!
//! Values are 64 bits, so a code is 14 symbols in the device-ID alphabet plus one
//! check symbol. Inverting a 64-bit hash is ~2^64 work: beyond a casual attacker, which
//! is the bar this product sets (packaging/LICENSING.md §15). Each code is mixed with the
//! device ID, so the one read to one shop does not work typed into another.
//!
//! ## What a code grants
//!
//! Full operation through the end of the day the provider chose (1–30 days ahead),
//! judged against the latest time the installation has ever recorded — so winding the
//! clock back does not stretch it. It is not a licence. It keeps a shop trading until a
//! proper code can be delivered.

use sha2::{Digest, Sha256};

use crate::device::ALPHABET;

/// Symbols carrying the value.
pub const VALUE_SYMBOLS: usize = 14;
/// Symbols in a code, the check symbol included.
pub const CODE_SYMBOLS: usize = VALUE_SYMBOLS + 1;
/// A code for chain day `d` runs until the start of day `d + WINDOW_DAYS`.
pub const WINDOW_DAYS: i64 = 7;
/// The longest window the provider can grant with one code.
pub const MAX_DAYS: u32 = 30;
/// Days a chain covers: twenty years from the key.
pub const CHAIN_LENGTH: u32 = 7300;
/// The chain starts this many days before the key was made, so a one-day code issued on
/// the key's first day still has a day index of zero or more.
pub const EPOCH_LEAD_DAYS: i64 = WINDOW_DAYS + 1;

const DAY: i64 = 86_400;
const BASE: u128 = 30;

/// The public half of a chain: what a program needs to check codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chain {
    /// Day number (days since 1970-01-01, UTC) of chain day 0.
    pub epoch_day: i64,
    pub length: u32,
    pub tip: u64,
}

impl Chain {
    /// The chain for `secret`, starting on `epoch_day`.
    pub fn new(secret: &[u8; 32], epoch_day: i64, length: u32) -> Chain {
        Chain { epoch_day, length, tip: value(secret, length, 0) }
    }

    /// When a code for chain day `day` stops working.
    pub fn valid_until(&self, day: u32) -> i64 {
        (self.epoch_day + i64::from(day) + WINDOW_DAYS) * DAY
    }

    /// The day the key was made. A system clock earlier than this cannot be right —
    /// this program did not exist yet — which is how a dead CMOS battery is told apart
    /// from someone winding the clock back.
    pub fn created_at(&self) -> i64 {
        (self.epoch_day + EPOCH_LEAD_DAYS) * DAY
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnlockError {
    /// Not fifteen symbols from the alphabet.
    Malformed,
    /// The check symbol does not match: a symbol was misheard or mistyped.
    Typo,
    /// Well-formed, but not a code for this device from this program's chain.
    NotValid,
    /// Genuine, and its window has passed.
    Expired { valid_until: i64 },
}

impl UnlockError {
    pub fn code(&self) -> &'static str {
        match self {
            UnlockError::Malformed => "MALFORMED",
            UnlockError::Typo => "TYPO",
            UnlockError::NotValid => "NOT_VALID",
            UnlockError::Expired { .. } => "EXPIRED",
        }
    }
}

/// A code that checked out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unlock {
    pub day: u32,
    pub valid_until: i64,
    /// The code as the issuer prints it — what is stored.
    pub normalized: String,
}

/// A code the issuer made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issued {
    pub code: String,
    pub day: u32,
    pub valid_until: i64,
}

fn digest64(parts: &[&[u8]]) -> u64 {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    let digest = hasher.finalize();
    u64::from_be_bytes(digest[..8].try_into().expect("a SHA-256 has 32 bytes"))
}

/// The chain secret, derived from the issuer's Ed25519 seed. Never stored on its own.
pub fn chain_secret(signing_seed: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"walaa-unlock-secret-v1|");
    hasher.update(signing_seed);
    hasher.finalize().into()
}

fn first(secret: &[u8; 32]) -> u64 {
    digest64(&[b"walaa-unlock-chain-v1|", secret])
}

/// One link of the chain.
pub fn step(x: u64) -> u64 {
    digest64(&[b"walaa-unlock-step-v1|", &x.to_be_bytes()])
}

/// The value for chain day `day`: `length - day` steps from the start.
fn value(secret: &[u8; 32], length: u32, day: u32) -> u64 {
    let mut v = first(secret);
    for _ in day..length {
        v = step(v);
    }
    v
}

fn bind(device_id: &str) -> u64 {
    digest64(&[b"walaa-unlock-bind-v1|", device_id.as_bytes()])
}

/// Luhn mod 30: catches every single wrong symbol and most swapped neighbours — the
/// two mistakes a code read over a phone line actually suffers.
fn check_symbol(digits: &[usize]) -> usize {
    let n = BASE as usize;
    let mut factor = 2;
    let mut sum = 0;
    for &digit in digits.iter().rev() {
        let addend = factor * digit;
        sum += addend / n + addend % n;
        factor = 3 - factor;
    }
    (n - sum % n) % n
}

/// `XXXXX-XXXXX-XXXXX`.
pub fn encode(x: u64) -> String {
    let mut digits = [0usize; VALUE_SYMBOLS];
    let mut n = u128::from(x);
    for slot in digits.iter_mut().rev() {
        *slot = (n % BASE) as usize;
        n /= BASE;
    }
    let check = check_symbol(&digits);
    let symbols: String = digits.iter().chain(std::iter::once(&check)).map(|&d| ALPHABET[d] as char).collect();
    format!("{}-{}-{}", &symbols[..5], &symbols[5..10], &symbols[10..])
}

/// A code as typed: case, spaces, dashes and Arabic-Indic digits do not matter.
pub fn normalize(text: &str) -> String {
    text.chars()
        .filter_map(|c| match c {
            '\u{0660}'..='\u{0669}' => char::from_digit(c as u32 - 0x0660, 10),
            '\u{06F0}'..='\u{06F9}' => char::from_digit(c as u32 - 0x06F0, 10),
            c if c.is_ascii_alphanumeric() => Some(c.to_ascii_uppercase()),
            _ => None,
        })
        .collect()
}

/// The 64-bit value in a typed code, or why there is none.
pub fn decode(text: &str) -> Result<u64, UnlockError> {
    let symbols = normalize(text);
    if symbols.len() != CODE_SYMBOLS {
        return Err(UnlockError::Malformed);
    }
    let digits: Vec<usize> = symbols
        .bytes()
        .map(|b| ALPHABET.iter().position(|&a| a == b))
        .collect::<Option<_>>()
        .ok_or(UnlockError::Malformed)?;
    if check_symbol(&digits[..VALUE_SYMBOLS]) != digits[VALUE_SYMBOLS] {
        return Err(UnlockError::Typo);
    }
    let n = digits[..VALUE_SYMBOLS].iter().fold(0u128, |n, &d| n * BASE + d as u128);
    u64::try_from(n).map_err(|_| UnlockError::Malformed)
}

/// Checks a code for `device_id` against `chain`, without judging its window.
pub fn read(text: &str, device_id: &str, chain: &Chain) -> Result<Unlock, UnlockError> {
    let x = decode(text)?;
    let mut y = x ^ bind(device_id);
    for day in 0..=chain.length {
        if y == chain.tip {
            return Ok(Unlock { day, valid_until: chain.valid_until(day), normalized: encode(x) });
        }
        y = step(y);
    }
    Err(UnlockError::NotValid)
}

/// Checks a code and its window. `reference` is the later of the system clock and the
/// latest time this installation has recorded, so a clock wound back cannot revive an
/// expired code.
pub fn verify(text: &str, device_id: &str, chain: &Chain, reference: i64) -> Result<Unlock, UnlockError> {
    let unlock = read(text, device_id, chain)?;
    if unlock.valid_until <= reference {
        return Err(UnlockError::Expired { valid_until: unlock.valid_until });
    }
    Ok(unlock)
}

/// The issuer's side: a code for `device_id` that runs through the end of the UTC day
/// `days` days after `now`.
pub fn issue(secret: &[u8; 32], chain: &Chain, device_id: &str, now: i64, days: u32) -> Result<Issued, String> {
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(format!("--days must be between 1 and {MAX_DAYS}"));
    }
    if Chain::new(secret, chain.epoch_day, chain.length) != *chain {
        return Err("this key's unlock chain does not match its private key".into());
    }
    let today = now.div_euclid(DAY);
    let day = today + i64::from(days) + 1 - WINDOW_DAYS - chain.epoch_day;
    if day < 0 || day > i64::from(chain.length) {
        return Err("that date is outside this key's unlock chain".into());
    }
    let day = day as u32;
    Ok(Issued {
        code: encode(value(secret, chain.length, day) ^ bind(device_id)),
        day,
        valid_until: chain.valid_until(day),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_789_400_000; // 2026-09-14 15:33 UTC
    const SECRET: [u8; 32] = [0x42; 32];
    const DEVICE: &str = "WL-7K3M-9QXP";

    fn chain() -> Chain {
        Chain::new(&SECRET, NOW / DAY - EPOCH_LEAD_DAYS - 10, CHAIN_LENGTH)
    }

    #[test]
    fn a_code_round_trips_and_runs_through_the_chosen_day() {
        for days in [1, 7, 30] {
            let issued = issue(&SECRET, &chain(), DEVICE, NOW, days).unwrap();
            assert_eq!(issued.code.len(), 17, "{}", issued.code);
            let unlock = verify(&issued.code, DEVICE, &chain(), NOW).unwrap();
            assert_eq!(unlock.day, issued.day);
            // Through the end of the UTC day `days` days from now.
            assert_eq!(unlock.valid_until, (NOW / DAY + i64::from(days) + 1) * DAY);
            assert_eq!(unlock.normalized, issued.code);
        }
    }

    #[test]
    fn a_code_read_over_the_phone_is_accepted_however_it_is_typed() {
        let issued = issue(&SECRET, &chain(), DEVICE, NOW, 7).unwrap();
        let spoken = issued.code.to_lowercase().replace('-', "  ");
        assert!(verify(&spoken, DEVICE, &chain(), NOW).is_ok());
        let arabic_digits: String = issued
            .code
            .chars()
            .map(|c| c.to_digit(10).map_or(c, |d| char::from_u32(0x0660 + d).unwrap()))
            .collect();
        assert!(verify(&arabic_digits, DEVICE, &chain(), NOW).is_ok());
    }

    #[test]
    fn every_single_misheard_symbol_is_caught_as_a_typo() {
        let issued = issue(&SECRET, &chain(), DEVICE, NOW, 7).unwrap();
        let symbols: Vec<u8> = normalize(&issued.code).into_bytes();
        for position in 0..CODE_SYMBOLS {
            for &replacement in ALPHABET.iter() {
                if replacement == symbols[position] {
                    continue;
                }
                let mut wrong = symbols.clone();
                wrong[position] = replacement;
                let result = decode(std::str::from_utf8(&wrong).unwrap());
                assert!(
                    matches!(result, Err(UnlockError::Typo)),
                    "position {position} → {} gave {result:?}",
                    replacement as char
                );
            }
        }
    }

    #[test]
    fn a_code_for_one_shop_does_not_work_in_another() {
        let issued = issue(&SECRET, &chain(), DEVICE, NOW, 7).unwrap();
        assert_eq!(read(&issued.code, "WL-2222-2222", &chain()), Err(UnlockError::NotValid));
    }

    #[test]
    fn a_code_from_another_key_is_not_valid() {
        let issued = issue(&SECRET, &chain(), DEVICE, NOW, 7).unwrap();
        let other = Chain::new(&[0x43; 32], chain().epoch_day, CHAIN_LENGTH);
        assert_eq!(read(&issued.code, DEVICE, &other), Err(UnlockError::NotValid));
    }

    #[test]
    fn an_old_code_is_expired_and_a_wound_back_clock_does_not_revive_it() {
        let issued = issue(&SECRET, &chain(), DEVICE, NOW, 3).unwrap();
        let after = issued.valid_until + 60;
        assert_eq!(verify(&issued.code, DEVICE, &chain(), after), Err(UnlockError::Expired { valid_until: issued.valid_until }));
        // The caller passes max(system clock, latest recorded time): a clock set back to
        // the issue day does not bring the window back.
        let reference = (NOW - DAY).max(after);
        assert!(verify(&issued.code, DEVICE, &chain(), reference).is_err());
    }

    #[test]
    fn random_symbols_with_a_valid_check_are_not_codes() {
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..40 {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            let forged = encode(state);
            assert_eq!(read(&forged, DEVICE, &chain()), Err(UnlockError::NotValid), "{forged}");
        }
    }

    #[test]
    fn nonsense_is_malformed() {
        for text in ["", "ABCDE", "ABCDE-FGHJK-MNPQR-S", "ABCDE-FGHJK-MNPQ1", "هذا ليس رمزاً"] {
            assert_eq!(decode(text), Err(UnlockError::Malformed), "{text}");
        }
    }

    #[test]
    fn the_issuer_refuses_windows_outside_one_to_thirty_days() {
        assert!(issue(&SECRET, &chain(), DEVICE, NOW, 0).is_err());
        assert!(issue(&SECRET, &chain(), DEVICE, NOW, 31).is_err());
        let mismatched = Chain { tip: chain().tip ^ 1, ..chain() };
        assert!(issue(&SECRET, &mismatched, DEVICE, NOW, 7).is_err());
    }

    #[test]
    fn a_one_day_code_on_the_keys_first_day_is_inside_the_chain() {
        let created = Chain::new(&SECRET, NOW / DAY - EPOCH_LEAD_DAYS, CHAIN_LENGTH);
        assert_eq!(created.created_at(), (NOW / DAY) * DAY);
        let issued = issue(&SECRET, &created, DEVICE, NOW, 1).unwrap();
        assert!(verify(&issued.code, DEVICE, &created, NOW).is_ok());
    }
}
