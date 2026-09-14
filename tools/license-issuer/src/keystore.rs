//! The private key at rest: encrypted with a key derived from the vendor's password.
//!
//! Argon2id turns the password into a 256-bit key (64 MiB, 3 passes — slow on
//! purpose, so a stolen file cannot be guessed at speed), and XChaCha20-Poly1305
//! encrypts the 32-byte Ed25519 seed. The public key and the file's format name are
//! bound in as associated data, so the ciphertext cannot be moved onto a different
//! public key without failing to decrypt.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload as AeadPayload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use walaa_license::{key_fingerprint, KeyKind};
use zeroize::Zeroize;

pub const FORMAT: &str = "walaa-issuer-key-v1";
pub const MIN_PASSWORD_CHARS: usize = 12;

const MEMORY_KIB: u32 = 64 * 1024;
const ITERATIONS: u32 = 3;
const PARALLELISM: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct KeyFile {
    pub format: String,
    pub kind: String,
    pub public_key: String,
    pub fingerprint: String,
    pub created_at: String,
    pub kdf: Kdf,
    pub cipher: Cipher,
}

#[derive(Serialize, Deserialize)]
pub struct Kdf {
    pub algorithm: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: String,
}

#[derive(Serialize, Deserialize)]
pub struct Cipher {
    pub algorithm: String,
    pub nonce: String,
    pub ciphertext: String,
}

fn derive(password: &str, salt: &[u8], memory_kib: u32, iterations: u32, parallelism: u32) -> Result<[u8; 32], String> {
    let params = Params::new(memory_kib, iterations, parallelism, Some(32)).map_err(|e| e.to_string())?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

fn associated_data(public_key_hex: &str) -> Vec<u8> {
    format!("{FORMAT}|{public_key_hex}").into_bytes()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("odd-length hex".into());
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

/// A new key pair, encrypted under `password`.
pub fn generate(password: &str, kind: KeyKind, created_at: &str) -> Result<(KeyFile, SigningKey), String> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(format!("the password must be at least {MIN_PASSWORD_CHARS} characters"));
    }
    let signing = SigningKey::generate(&mut OsRng);
    let file = seal(&signing, password, kind, created_at)?;
    Ok((file, signing))
}

/// Encrypts an existing signing key. `generate` is the normal way in.
pub fn seal(signing: &SigningKey, password: &str, kind: KeyKind, created_at: &str) -> Result<KeyFile, String> {
    let public = signing.verifying_key().to_bytes();
    let public_hex = hex(&public);

    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);

    let mut key = derive(password, &salt, MEMORY_KIB, ITERATIONS, PARALLELISM)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let aad = associated_data(&public_hex);
    let mut seed = signing.to_bytes();
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), AeadPayload { msg: &seed, aad: &aad })
        .map_err(|_| "encryption failed".to_string())?;
    seed.zeroize();
    key.zeroize();

    Ok(KeyFile {
        format: FORMAT.into(),
        kind: kind.as_str().into(),
        fingerprint: key_fingerprint(&public),
        public_key: public_hex,
        created_at: created_at.into(),
        kdf: Kdf {
            algorithm: "argon2id".into(),
            memory_kib: MEMORY_KIB,
            iterations: ITERATIONS,
            parallelism: PARALLELISM,
            salt: STANDARD.encode(salt),
        },
        cipher: Cipher {
            algorithm: "xchacha20poly1305".into(),
            nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(ciphertext),
        },
    })
}

/// Decrypts the key. A wrong password and a damaged file both fail here, before
/// anything is signed.
pub fn open(file: &KeyFile, password: &str) -> Result<SigningKey, String> {
    if file.format != FORMAT {
        return Err(format!("unknown key file format {:?}", file.format));
    }
    let salt = STANDARD.decode(&file.kdf.salt).map_err(|e| e.to_string())?;
    let nonce = STANDARD.decode(&file.cipher.nonce).map_err(|e| e.to_string())?;
    let ciphertext = STANDARD.decode(&file.cipher.ciphertext).map_err(|e| e.to_string())?;
    if nonce.len() != 24 {
        return Err("damaged key file (nonce)".into());
    }

    let mut key = derive(password, &salt, file.kdf.memory_kib, file.kdf.iterations, file.kdf.parallelism)?;
    let cipher = XChaCha20Poly1305::new((&key).into());
    let plain = cipher.decrypt(
        XNonce::from_slice(&nonce),
        AeadPayload { msg: &ciphertext, aad: &associated_data(&file.public_key) },
    );
    key.zeroize();
    let mut seed = plain.map_err(|_| "wrong password, or the key file is damaged".to_string())?;

    let seed_array: [u8; 32] = seed.as_slice().try_into().map_err(|_| "damaged key file (seed)".to_string())?;
    seed.zeroize();
    let signing = SigningKey::from_bytes(&seed_array);

    let expected = unhex(&file.public_key)?;
    if signing.verifying_key().to_bytes().as_slice() != expected.as_slice() {
        return Err("the key file's public key does not match its private key".into());
    }
    Ok(signing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_with_the_right_password_only() {
        let (file, signing) = generate("correct horse battery", KeyKind::Production, "now").unwrap();
        let opened = open(&file, "correct horse battery").unwrap();
        assert_eq!(opened.to_bytes(), signing.to_bytes());
        assert!(open(&file, "correct horse batterY").is_err());
    }

    #[test]
    fn refuses_a_short_password() {
        assert!(generate("short", KeyKind::Production, "now").is_err());
    }

    #[test]
    fn the_private_key_is_not_in_the_file() {
        let (file, signing) = generate("correct horse battery", KeyKind::Production, "now").unwrap();
        let json = serde_json::to_string(&file).unwrap();
        assert!(!json.contains(&hex(&signing.to_bytes())));
        assert!(!json.contains(&STANDARD.encode(signing.to_bytes())));
    }

    #[test]
    fn a_ciphertext_moved_to_another_public_key_does_not_open() {
        let (mut file, _) = generate("correct horse battery", KeyKind::Production, "now").unwrap();
        let (other, _) = generate("correct horse battery", KeyKind::Production, "now").unwrap();
        file.public_key = other.public_key;
        assert!(open(&file, "correct horse battery").is_err());
    }
}
