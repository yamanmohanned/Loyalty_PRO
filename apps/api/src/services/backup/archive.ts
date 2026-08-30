import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { fingerprintMatches, keyFingerprint } from './key';

/**
 * The backup archive format (CLAUDE_v3.md §7.3, §12.17).
 *
 * §7.3 makes encryption before upload mandatory: financial data must never leave the
 * merchant's machine in plaintext to third-party storage. This module is the whole of
 * that promise — everything written to Drive, to a local folder or to a USB stick goes
 * through here.
 *
 * ## Layout
 *
 * ```
 *   magic        8 bytes   "WALAABK1"
 *   headerLen    4 bytes   uint32 big-endian
 *   header       N bytes   JSON, UTF-8, PLAINTEXT — and authenticated (see below)
 *   iv          12 bytes   random per archive
 *   ciphertext   …         gzip(snapshot) encrypted with AES-256-GCM
 *   tag         16 bytes   GCM authentication tag, at the very end
 * ```
 *
 * ## Why each of those
 *
 * **The header is plaintext on purpose, and carries nothing identifying.** A restore
 * tool has to be able to list archives, read their dates and check their format version
 * without the key — otherwise recovering from a lost machine starts with guesswork. So
 * the header holds version, algorithm, timestamps, sizes and a checksum, and it holds
 * no merchant name, no shop name, no customer data and no identifiers. Whoever can see
 * the file learns when a backup was taken and how big it was, and nothing about whose
 * it is.
 *
 * **The header is the GCM additional-authenticated-data.** Plaintext is not the same as
 * unprotected: editing a byte of the header makes decryption fail rather than silently
 * changing what the restore believes about the file.
 *
 * **gzip before encryption.** A SQLite database is highly compressible and ciphertext is
 * not, so the order is forced. The size-leak concern that makes compress-then-encrypt
 * dangerous in interactive protocols does not apply to an at-rest archive with no
 * attacker-chosen plaintext.
 *
 * **The tag is at the end**, which is where a streaming cipher can produce it. Node
 * requires the tag *before* decryption, so reading seeks to the last 16 bytes first.
 * Everything else streams: this file will be a gigabyte in a few years, on a machine
 * §12.15 establishes is short of both disk and memory.
 *
 * **The key is not in here.** Where it lives, and the rule that a key existing only on
 * the machine being backed up is not a backup at all, is `key.ts`.
 */

const MAGIC = Buffer.from('WALAABK1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_LENGTH_BYTES = 4;

/** AES-256 takes a 256-bit key. */
export const KEY_BYTES = 32;

/**
 * Refuses a header big enough to be an attack rather than a header.
 *
 * `headerLen` is read from the file before anything has been authenticated, and it
 * sizes an allocation. A corrupt or hostile four bytes would otherwise ask for four
 * gigabytes on a till.
 */
const MAX_HEADER_BYTES = 64 * 1024;

export interface ArchiveHeader {
  /** Format version. Bumped only for a change a previous reader could not handle. */
  version: 1;
  algorithm: 'aes-256-gcm';
  compression: 'gzip';
  /** ISO-8601 UTC. */
  createdAt: string;
  /** Size of the uncompressed snapshot, for a restore-time sanity check. */
  plaintextBytes: number;
  /**
   * SHA-256 of the uncompressed snapshot.
   *
   * The GCM tag already proves the ciphertext was not altered. This proves something
   * different and worth having separately: that what came *out* of the decrypt-and-
   * decompress is byte-for-byte what went in, catching a gzip bug or a truncated write
   * rather than only tampering.
   */
  plaintextSha256: string;
  /**
   * Which key opens this archive — see `keyFingerprint`.
   *
   * Present so a wrong key fails as "this archive needs a different key" rather than as
   * a GCM authentication error, which is the same message a corrupt file produces and
   * sends the person recovering their shop down the wrong road.
   */
  keyFingerprint: string;
}

export interface WriteResult {
  header: ArchiveHeader;
  /** Size of the finished archive on disk. */
  archiveBytes: number;
}

/** Serialises a header and checks it against the read-side limit before writing. */
function encodeHeader(header: ArchiveHeader): Buffer {
  const encoded = Buffer.from(JSON.stringify(header), 'utf8');
  if (encoded.byteLength > MAX_HEADER_BYTES) {
    throw new Error('ترويسة النسخة الاحتياطية أكبر من الحد المسموح');
  }
  return encoded;
}

/**
 * Encrypts `sourcePath` into `archivePath`.
 *
 * Two passes over the source: one to hash and measure it, one to compress and encrypt.
 * The alternative — hashing inline and rewriting the header afterwards — would put the
 * checksum outside the authenticated header or force the whole archive into memory.
 * A second sequential read of a local file is the cheaper trade.
 */
export async function writeArchive(
  sourcePath: string,
  archivePath: string,
  key: Buffer,
  now: Date = new Date(),
): Promise<WriteResult> {
  assertKey(key);

  const { size } = await stat(sourcePath);
  const plaintextSha256 = await sha256File(sourcePath);

  const header: ArchiveHeader = {
    version: 1,
    algorithm: 'aes-256-gcm',
    compression: 'gzip',
    createdAt: now.toISOString(),
    plaintextBytes: size,
    plaintextSha256,
    keyFingerprint: keyFingerprint(key),
  };

  const encodedHeader = encodeHeader(header);
  const lengthPrefix = Buffer.alloc(HEADER_LENGTH_BYTES);
  lengthPrefix.writeUInt32BE(encodedHeader.byteLength, 0);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(encodedHeader);

  const out = createWriteStream(archivePath);
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.write(Buffer.concat([MAGIC, lengthPrefix, encodedHeader, iv]), (error) =>
      error ? reject(error) : resolve(),
    );
  });

  await pipeline(createReadStream(sourcePath), createGzip(), cipher, out, { end: false });

  // Produced only once the cipher has seen every byte, which is why it lives at the end.
  const tag = cipher.getAuthTag();
  await new Promise<void>((resolve, reject) => {
    out.end(tag, () => resolve());
    out.on('error', reject);
  });

  const { size: archiveBytes } = await stat(archivePath);
  return { header, archiveBytes };
}

/**
 * Reads an archive's header without the key.
 *
 * Deliberately possible. Recovery from a dead machine begins with someone looking at a
 * folder of files and needing to know which is the newest and whether this software can
 * still read it.
 */
export async function readArchiveHeader(archivePath: string): Promise<ArchiveHeader> {
  const handle = await open(archivePath, 'r');
  try {
    const prefix = Buffer.alloc(MAGIC.byteLength + HEADER_LENGTH_BYTES);
    const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0);
    if (bytesRead < prefix.byteLength || !prefix.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      throw new Error('هذا الملف ليس نسخة احتياطية من ولاء');
    }

    const headerLength = prefix.readUInt32BE(MAGIC.byteLength);
    if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
      throw new Error('ترويسة النسخة الاحتياطية تالفة');
    }

    const headerBuffer = Buffer.alloc(headerLength);
    await handle.read(headerBuffer, 0, headerLength, prefix.byteLength);
    return JSON.parse(headerBuffer.toString('utf8')) as ArchiveHeader;
  } finally {
    await handle.close();
  }
}

/**
 * Decrypts `archivePath` to `destinationPath`, verifying both the GCM tag and the
 * plaintext checksum.
 *
 * A failure here throws rather than producing a partial file the caller might mistake
 * for a restore. That is the whole point of §12.17: a backup that appears to work and
 * is silently wrong is worse than one that plainly does not.
 */
export async function readArchive(
  archivePath: string,
  destinationPath: string,
  key: Buffer,
): Promise<ArchiveHeader> {
  assertKey(key);

  const header = await readArchiveHeader(archivePath);
  if (header.version !== 1 || header.algorithm !== 'aes-256-gcm' || header.compression !== 'gzip') {
    throw new Error(`نسخة احتياطية بصيغة غير مدعومة (${header.version}/${header.algorithm})`);
  }

  // Checked before any decryption so the failure names the actual problem.
  if (!fingerprintMatches(header.keyFingerprint, keyFingerprint(key))) {
    throw new Error(
      `هذه النسخة الاحتياطية مشفّرة بمفتاح آخر (تحتاج المفتاح ${header.keyFingerprint})`,
    );
  }

  const encodedHeader = encodeHeader(header);
  const headerEnd = MAGIC.byteLength + HEADER_LENGTH_BYTES + encodedHeader.byteLength;

  const handle = await open(archivePath, 'r');
  let iv: Buffer;
  let tag: Buffer;
  let ciphertextEnd: number;
  try {
    const { size } = await handle.stat();
    ciphertextEnd = size - TAG_BYTES;
    if (ciphertextEnd <= headerEnd + IV_BYTES) {
      throw new Error('النسخة الاحتياطية ناقصة أو تالفة');
    }

    iv = Buffer.alloc(IV_BYTES);
    await handle.read(iv, 0, IV_BYTES, headerEnd);

    // Node needs the tag before `final()`, and a streaming cipher can only emit it
    // after the last byte — hence the seek to the end before reading the body.
    tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, ciphertextEnd);
  } finally {
    await handle.close();
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(encodedHeader);
  decipher.setAuthTag(tag);

  await pipeline(
    createReadStream(archivePath, { start: headerEnd + IV_BYTES, end: ciphertextEnd - 1 }),
    decipher,
    createGunzip(),
    createWriteStream(destinationPath),
  );

  const actual = await sha256File(destinationPath);
  if (actual !== header.plaintextSha256) {
    throw new Error('فشل التحقق من سلامة النسخة الاحتياطية بعد فك التشفير');
  }

  return header;
}

function assertKey(key: Buffer): void {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`مفتاح التشفير يجب أن يكون ${KEY_BYTES} بايت`);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
