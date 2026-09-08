import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadEnv } from '../config/env';
import { liveDatabasePath } from '../config/paths';
import { readArchiveHeader } from '../services/backup/archive';
import {
  localBackupDirectory,
  restoreArchive,
  type RestoreResult,
} from '../services/backup/backup.service';
import { parseBackupKey } from '../services/backup/key';
import { readFreeSpace } from '../services/storage.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OPENING AN ARCHIVE — the other half of §7.3
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## The gap this closes
 *
 * Everything needed to *make* a backup shipped: the snapshot, the encryption, three
 * destinations, a scheduler, a monthly verification, and a key ceremony (§12.19) whose
 * entire purpose is to get the key written down and off the machine.
 *
 * Nothing shipped that could *open* one. `restoreArchive` existed but was reachable
 * only from `verifyRestore`, which decrypts into a scratch file and deletes it in a
 * `finally`. There was no route, no command and no script. Meanwhile the failure
 * messages the merchant actually sees — `lib/db-integrity.ts` on a corrupt file — say
 * «استعد أحدث نسخة احتياطية», *restore the most recent backup*, and the packaging
 * runbook's replacement procedure opens with "put the replacement `walaa.db` in place".
 *
 * A `.walaabk` is AES-256-GCM over gzip. Nothing outside this codebase turns one into a
 * `walaa.db`. So the shop with a dead disk had: archives in Drive, archives on a USB
 * stick, a key on a piece of paper — and no way to use any of it. That is §12.19's
 * "intact, encrypted, permanently unrecoverable" reached from the opposite direction,
 * and it is worse than the case §12.19 guards against, because here every instruction
 * the product gives implies the capability exists.
 *
 * ## Why a command and not an endpoint
 *
 * §12.18's ruling stands and this does not weaken it: **restoring over the live database
 * is not offered.** A process cannot overwrite the SQLite file it has open, an endpoint
 * a scheduler could reach must be incapable of destroying what it protects, and the
 * replacement is a decision with a stopped service behind it.
 *
 * So this writes a *new file* and reports on it, and the operator puts it in place with
 * the service stopped, following the runbook (`packaging/README.md`, "Replacing the
 * database file"). The tool refuses outright to write to the live database path and says
 * so with the path named, rather than letting a mistyped `--to` corrupt a shop mid-trade.
 *
 * ## Why `--key` exists
 *
 * The recovery this subsystem is for is "the machine is gone". What replaces it is a
 * fresh install, which generates its **own** `BACKUP_KEY` — one that opens nothing. The
 * only key that opens last month's archive is the one the merchant wrote down during the
 * ceremony. A ceremony that produces a key with nowhere to type it is theatre.
 *
 * ## Usage
 *
 *   walaa-restore --list
 *   walaa-restore <archive.walaabk> --to <output.db> [--key <base64>] [--force]
 *
 * `--list` needs no key: the archive header is plaintext by design (`archive.ts`), so a
 * folder of files can be dated and identified before anyone finds the paper.
 */

const USAGE = [
  'الاستخدام:',
  '  walaa-restore --list',
  '        يعرض النسخ الاحتياطية الموجودة في المجلد المحلي مع تاريخ كل واحدة وبصمة مفتاحها.',
  '',
  '  walaa-restore <ملف.walaabk> --to <مسار الملف الناتج.db> [--key <المفتاح>] [--force]',
  '        يفكّ تشفير النسخة إلى ملف قاعدة بيانات جديد ويفحصه.',
  '',
  '  --key    المفتاح المكتوب في ورقة الحفظ (base64). بدونه يُستخدم مفتاح هذا الجهاز.',
  '  --force  يسمح بالكتابة فوق ملف ناتج موجود مسبقاً.',
  '',
  'هذه الأداة لا تكتب أبداً فوق قاعدة البيانات العاملة. بعد نجاحها، أوقف الخدمة وانسخ',
  'الملف الناتج إلى مكانه حسب الإجراء المذكور في دليل التشغيل.',
].join('\n');

interface Args {
  archive: string | null;
  to: string | null;
  key: string | null;
  force: boolean;
  list: boolean;
  help: boolean;
}

/**
 * Parses the command line, rejecting anything unrecognised.
 *
 * Strict rather than lenient for the same reason every request body in this product is
 * (§7.4): a typo'd flag that is silently ignored on a recovery command is a merchant
 * believing they passed `--key` when they did not.
 */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { archive: null, to: null, key: null, force: false, list: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    switch (token) {
      case '--list':
        args.list = true;
        break;
      case '--force':
        args.force = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--to':
      case '--key': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`الخيار ${token} يحتاج قيمة بعده.`);
        }
        if (token === '--to') args.to = value;
        else args.key = value;
        i += 1;
        break;
      }
      default:
        if (token.startsWith('-')) throw new Error(`خيار غير معروف: ${token}`);
        if (args.archive) throw new Error('يمكن تحديد ملف نسخة احتياطية واحد فقط.');
        args.archive = token;
    }
  }

  return args;
}

/**
 * How much room the output needs, measured against the archive rather than a constant.
 *
 * Twice the plaintext size: one copy is the file being written, and the second is
 * headroom for the operator's copy of it into the data directory and for the WAL SQLite
 * opens beside it. There is deliberately **no fixed floor**. `backup/snapshot.ts`
 * records what a fixed floor cost — a 256 MiB guard is harmless there and a 2 GiB one
 * refused to boot a shop over a 5.4 MB database — and a restore is the operation with
 * the least tolerance of all for a guard that refuses when there is plenty of room: the
 * person running it has already lost their database.
 */
export function requiredFreeBytes(plaintextBytes: number): number {
  return plaintextBytes * 2;
}

const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

async function listArchives(): Promise<number> {
  const directory = localBackupDirectory();
  if (!existsSync(directory)) {
    process.stdout.write(`لا يوجد مجلد نسخ احتياطية على هذا الجهاز: ${directory}\n`);
    return 1;
  }

  const names = (await readdir(directory)).filter((name) => name.endsWith('.walaabk')).sort();
  if (names.length === 0) {
    process.stdout.write(`لا توجد نسخ احتياطية في: ${directory}\n`);
    return 1;
  }

  process.stdout.write(`النسخ الاحتياطية في ${directory}:\n`);
  for (const name of names) {
    const path = join(directory, name);
    try {
      const header = await readArchiveHeader(path);
      const { size } = await stat(path);
      process.stdout.write(
        `  ${name}\n` +
          `      التاريخ ${header.createdAt} · الحجم ${mb(size)} · ` +
          `حجم قاعدة البيانات ${mb(header.plaintextBytes)} · بصمة المفتاح ${header.keyFingerprint}\n`,
      );
    } catch (error) {
      // A file that cannot be read is exactly what someone listing needs to see named,
      // not something to hide behind a shorter list.
      process.stdout.write(
        `  ${name}\n      تعذّرت قراءة الترويسة: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return 0;
}

/** Everything checked before a single byte is written. */
async function guard(args: Args & { archive: string; to: string }): Promise<{
  archive: string;
  destination: string;
  key: Buffer;
  plaintextBytes: number;
}> {
  const archive = resolve(args.archive);
  if (!existsSync(archive)) {
    throw new Error(`ملف النسخة الاحتياطية غير موجود: ${archive}`);
  }

  const destination = resolve(args.to);

  // ═══ NEVER THE LIVE FILE ═══
  //
  // Compared against the path SQLite would actually be given, not against the raw
  // string: `DATABASE_URL` may be relative, and `liveDatabasePath` is the one place that
  // resolves it the same way the service does. A restore that silently landed on the
  // shop's database — while the service held it open, mid-trade — is the failure this
  // whole module exists to prevent, arriving from the tool meant to fix it.
  const live = liveDatabasePath(loadEnv().DATABASE_URL);
  if (live && resolve(live).toLowerCase() === destination.toLowerCase()) {
    throw new Error(
      `لا يمكن الكتابة فوق قاعدة البيانات العاملة: ${live}\n` +
        'اكتب الملف الناتج في مسار آخر، ثم أوقف الخدمة وانقله إلى مكانه ' +
        '(مع حذف الملفين المرافقين walaa.db-wal و walaa.db-shm العائدين للملف القديم) ' +
        'حسب إجراء «استبدال ملف قاعدة البيانات» في دليل التشغيل.',
    );
  }

  if (existsSync(destination) && !args.force) {
    throw new Error(
      `الملف الناتج موجود مسبقاً: ${destination}\n` +
        'اختر مساراً آخر، أو أضف --force للكتابة فوقه.',
    );
  }

  const parent = dirname(destination);
  if (!existsSync(parent)) {
    throw new Error(`المجلد الذي سيُكتب فيه الملف غير موجود: ${parent}`);
  }

  // The header is plaintext and unauthenticated until decryption, so this both dates the
  // archive for the operator and gives the size the space check needs.
  const header = await readArchiveHeader(archive);

  const configured = loadEnv().BACKUP_KEY;
  const key = parseBackupKey(args.key ?? configured);
  if (!key) {
    throw new Error(
      'لا يوجد مفتاح تشفير. أضف --key ومعه المفتاح المكتوب في ورقة الحفظ ' +
        `(هذه النسخة تحتاج المفتاح ذا البصمة ${header.keyFingerprint}).`,
    );
  }

  const { freeBytes } = readFreeSpace(parent);
  const requiredBytes = requiredFreeBytes(header.plaintextBytes);
  if (freeBytes < requiredBytes) {
    throw new Error(
      `لا توجد مساحة كافية في ${parent}: المتاح ${mb(freeBytes)}، والمطلوب ${mb(requiredBytes)} ` +
        `(حجم قاعدة البيانات داخل النسخة ${mb(header.plaintextBytes)} × 2). ` +
        'أفرغ مساحة على هذا القرص أو اكتب الملف الناتج على قرص آخر.',
    );
  }

  return { archive, destination, key, plaintextBytes: header.plaintextBytes };
}

function report(result: RestoreResult): number {
  const lines: string[] = [
    '',
    `تمت الاستعادة إلى: ${result.path}`,
    `  تاريخ النسخة        ${result.header.createdAt}`,
    `  بصمة المفتاح        ${result.header.keyFingerprint}`,
    `  فحص السلامة         ${result.integrity}`,
    `  مخالفات المفاتيح    ${result.foreignKeyViolations}`,
    `  الزبائن             ${result.counts.customers}`,
    `  الفواتير            ${result.counts.transactions}`,
    `  القسائم             ${result.counts.vouchers}`,
    `  سجلّ التدقيق        ${result.counts.auditEntries}`,
    `  آخر عملية مسجّلة    ${result.latestAuditAt ?? '(لا يوجد)'}`,
  ];

  let exitCode = 0;

  if (result.integrity !== 'ok') {
    lines.push(
      '',
      `تحذير: فحص السلامة لم يُرجع ok — أعاد «${result.integrity}». ` +
        'لا تستخدم هذا الملف؛ جرّب نسخة احتياطية أقدم.',
    );
    exitCode = 2;
  }

  if (result.foreignKeyViolations > 0) {
    // Loud, and not fatal — the same split `lib/db-integrity.ts` makes at boot. The
    // pages are sound; some historical row points at a parent that is not there, and
    // that is not a reason to withhold a shop's entire ledger from it.
    lines.push(
      '',
      `تنبيه: ${result.foreignKeyViolations} صفاً يشير إلى سجل غير موجود. ` +
        'الملف سليم بنيوياً ويمكن استخدامه، لكن أبلغ الدعم الفني بهذا الرقم.',
    );
  }

  if (!result.schemaMatchesBuild) {
    lines.push(
      '',
      'تنبيه: بنية قاعدة البيانات في هذه النسخة لا تطابق إصدار البرنامج المثبّت حالياً.',
      `  البنية في النسخة    ${result.schemaHash.slice(0, 16)}`,
      '  الملف سليم ويمكن الاحتفاظ به، لكن الخدمة سترفض التشغيل عليه.',
      '  المطلوب تثبيت نفس إصدار البرنامج الذي أُخذت به هذه النسخة، أو التواصل مع الدعم الفني.',
    );
    exitCode = 3;
  }

  if (exitCode === 0) {
    lines.push(
      '',
      'الخطوة التالية: أوقف الخدمة، خذ نسخة من مجلد البيانات كاملاً، ثم ضع هذا الملف',
      `مكان walaa.db واحذف walaa.db-wal و walaa.db-shm العائدين للملف القديم،`,
      'ثم شغّل الخدمة وتأكد من العدادات أعلاه على لوحة التحكم.',
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return exitCode;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 64;
  }

  if (args.help || (!args.list && !args.archive)) {
    process.stdout.write(`${USAGE}\n`);
    return args.help ? 0 : 64;
  }

  if (args.list) return listArchives();

  if (!args.to) {
    // Deliberately not defaulted. A default output path on a command whose job is to
    // materialise a database file is one keystroke away from writing it somewhere the
    // operator is not looking.
    process.stderr.write(`حدّد مسار الملف الناتج بالخيار --to.\n\n${USAGE}\n`);
    return 64;
  }

  try {
    const checked = await guard({ ...args, archive: args.archive!, to: args.to });
    process.stdout.write(
      `فكّ تشفير ${basename(checked.archive)} إلى ${checked.destination} …\n`,
    );
    const result = await restoreArchive(checked.archive, checked.destination, checked.key);
    return report(result);
  } catch (error) {
    process.stderr.write(
      `فشلت الاستعادة: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

