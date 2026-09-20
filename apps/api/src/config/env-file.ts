import { renameSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveEnvFile } from './paths';

/**
 * Writing one value back into the environment file.
 *
 * The service is normally a reader of its configuration, and this is the single
 * exception: the backup encryption key has to be generatable from the manager app,
 * because the alternative is a merchant who cannot turn on backups without an
 * Administrator editing a file — which is how the most important safeguard in the
 * product ends up never enabled (§7.3, §12.19).
 *
 * ## Why temp-then-rename is safe here, specifically
 *
 * `loyalty-pro.env` holds the JWT signing keys. Getting its permissions wrong would let any
 * local account mint tokens, so this deserves more than a shrug.
 *
 * The installer runs `icacls` on `%PROGRAMDATA%\Walaa` with `/inheritance:r` and grants
 * `(OI)(CI)(F)` to LocalSystem and Administrators — object-inherit and
 * container-inherit. A file newly created in that directory therefore inherits exactly
 * those two ACEs and nothing else; the `BUILTIN\Users:(RX)` that `%PROGRAMDATA%` grants
 * by default was removed from the directory and cannot propagate. Renaming within the
 * same directory keeps the source file's ACL. So the replacement lands with the same
 * protection as the file it replaces.
 *
 * The temporary file is written **in that same directory** for this reason, not in
 * `%TEMP%` — a cross-volume move would copy through a file created under a different,
 * unlocked ACL, and a rename across volumes is not atomic either.
 *
 * An in-place truncate-and-write would also preserve the ACL, and is rejected for a
 * different reason: a crash midway through leaves a half-written file, and a
 * `loyalty-pro.env` missing its JWT secrets does not start the till in the morning.
 */

/** The characters a value may contain without quoting. Anything else is rejected. */
const SAFE_VALUE = /^[A-Za-z0-9+/=_.:-]*$/;

export class EnvFileError extends Error {}

/**
 * Sets `key` to `value` in the environment file, replacing an existing line or
 * appending a new one.
 *
 * Refuses to overwrite a value that is already set unless `overwrite` is passed. That
 * default is the important part: silently replacing `BACKUP_KEY` would leave every
 * archive ever taken permanently unopenable, and the caller that wants that has to say
 * so in as many words.
 */
export function setEnvValue(
  key: string,
  value: string,
  options: { overwrite?: boolean; path?: string } = {},
): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new EnvFileError(`اسم متغيّر غير صالح: ${key}`);
  }
  if (!SAFE_VALUE.test(value)) {
    // Never quote-and-escape our way around this. A value needing quoting is a value
    // this function was not designed for, and guessing at dotenv's escaping rules is
    // how a config file silently starts meaning something else.
    throw new EnvFileError('القيمة تحتوي على رموز غير مدعومة');
  }

  const path = options.path ?? resolveEnvFile();
  if (!path) {
    throw new EnvFileError('لا يوجد ملف إعدادات لكتابة القيمة فيه');
  }

  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = original.split(/\r?\n/);

  const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`));
  if (index >= 0 && !options.overwrite) {
    const current = lines[index]!.slice(lines[index]!.indexOf('=') + 1).trim();
    if (current && current !== '""' && current !== "''") {
      throw new EnvFileError(`${key} مضبوط مسبقاً`);
    }
  }

  const line = `${key}="${value}"`;
  if (index >= 0) {
    lines[index] = line;
  } else {
    // Keep a trailing newline rather than gluing onto an unterminated last line.
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(line, '');
  }

  const staging = join(dirname(path), `.${key.toLowerCase()}.tmp`);
  writeFileSync(staging, lines.join('\n'), { encoding: 'utf8' });
  renameSync(staging, path);

  return path;
}
