import { basename } from 'node:path';
import { prisma } from './prisma';
import { PRIMARY_DEMO_LOGIN } from './demo-credentials';
import { verifyPassword } from './password';

/**
 * Proves, at runtime, that this build is talking to the database it is supposed to.
 *
 * ── The defect this exists to close ──────────────────────────────────────────
 *
 * The demo build shipped its shop as `walaa-demo.db` and the service configured the
 * API to open `walaa.db`. Two different names for what everyone assumed was one file.
 * `install_demo_seed_if_absent` then skipped — correctly, by its own rule — because a
 * `walaa.db` already existed on the machine from an earlier install, and the demo ran
 * against a database it had never placed and knew nothing about. On the machine where
 * this was found that file happened to be empty, so the visible symptom was six
 * unexpected migrations rather than a merchant's real customer list being opened by a
 * demo build. The next machine would not have been so lucky.
 *
 * The isolation check that was supposed to catch this greps the built bundle for demo
 * strings. That verifies which code shipped. It cannot verify **which file the process
 * opens**, which is the thing that actually matters, and which is only knowable once
 * the process is running and SQLite has answered.
 *
 * ── How it is checked ────────────────────────────────────────────────────────
 *
 * `PRAGMA database_list` reports the path SQLite genuinely has open — not the
 * `DATABASE_URL` we asked for, not an environment variable, not a build flag. Every
 * one of those is a thing a mistake gets wrong; the pragma is the ground truth.
 *
 * Two independent conditions, because either alone is defeatable:
 *
 *   1. **The name.** A demo build opens `walaa-demo.db` and nothing else; a production
 *      build opens a file with no `demo` in its name and nothing else. The two builds
 *      can now sit on one machine without being able to reach each other's data, and
 *      `assertDemoDatabase()` — which gates the destructive reset on the same
 *      substring — finally passes in a shipped demo, where it previously could not.
 *   2. **The provenance marker.** A row written into the file by the seed builder. A
 *      hand-made or Prisma-created `walaa-demo.db` has the right name and no marker,
 *      so "the installer placed this" is a claim the file itself has to support.
 *
 * The error names the exact file it looked at, because the whole failure above came
 * from nobody being able to say which file was in play.
 */

/** The only database basename a demo build will ever open. */
export const DEMO_DATABASE_BASENAME = 'walaa-demo.db';

/**
 * Whether this process is a demo build.
 *
 * Set by the service host from the shipped seed's presence, so it cannot disagree with
 * whether a demo database actually exists. Defined here rather than in `demo.service`
 * because the guard runs before the app is built, and importing the seed generator into
 * the boot path to read one environment variable would be a poor trade.
 */
export const isDemoBuild = (): boolean => process.env.WALAA_DEMO === '1';

/** Table carrying the seed builder's signature. Created by `seed-demo.ts`. */
const PROVENANCE_TABLE = 'demo_provenance';

export interface DemoProvenance {
  seedId: string;
  builtAt: string;
}

/** The path SQLite actually has open, as SQLite reports it. */
export async function openDatabaseFile(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ file: string | null }>>(
    'PRAGMA database_list',
  );
  return rows.find((r) => r.file)?.file ?? '';
}

/** The seed builder's signature, or null if this file was not built by it. */
export async function readDemoProvenance(): Promise<DemoProvenance | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ seedId: string; builtAt: string }>>(
      `SELECT seedId, builtAt FROM ${PROVENANCE_TABLE} LIMIT 1`,
    );
    const row = rows[0];
    return row?.seedId ? { seedId: row.seedId, builtAt: row.builtAt } : null;
  } catch {
    // No such table — which is the answer, not an error. Any database that was not
    // produced by the demo seed builder lands here.
    return null;
  }
}

/** Writes the signature. Called by the seed builder, never at runtime. */
export async function stampDemoProvenance(seedId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS ${PROVENANCE_TABLE} (
       id       INTEGER PRIMARY KEY CHECK (id = 1),
       seedId   TEXT NOT NULL,
       builtAt  TEXT NOT NULL
     )`,
  );
  await prisma.$executeRawUnsafe(`DELETE FROM ${PROVENANCE_TABLE}`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${PROVENANCE_TABLE} (id, seedId, builtAt) VALUES (1, ?, ?)`,
    seedId,
    new Date().toISOString(),
  );
}

/**
 * Refuses to run against the wrong database. Throws in Arabic, naming the file.
 *
 * Called before migrations, so a build that has attached itself to the wrong file
 * stops before it writes to it. Refusing to start is the correct outcome: the failure
 * mode being prevented is a demo build migrating, snapshotting and reseeding over a
 * shop's live customer data.
 */
export async function assertDatabaseMatchesBuild(
  log: (message: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const file = await openDatabaseFile();
  const name = basename(file);
  const demo = isDemoBuild();

  if (!demo) {
    // A production build must never open a demo file. The reverse direction of the
    // same guarantee, and the cheap half — there is no marker to consult.
    if (/demo/i.test(name)) {
      throw new Error(
        `هذه نسخة الإنتاج ولا يمكنها فتح قاعدة بيانات تجريبية. الملف المفتوح: «${file}». ` +
          `أعد تثبيت البرنامج أو صحّح مسار قاعدة البيانات في ملف الإعدادات.`,
      );
    }
    log('database checked', { file, build: 'production' });
    return;
  }

  if (name !== DEMO_DATABASE_BASENAME) {
    throw new Error(
      `النسخة التجريبية لا تعمل إلا على قاعدة بياناتها الخاصة «${DEMO_DATABASE_BASENAME}»، ` +
        `والملف المفتوح هو «${file}». تم إيقاف التشغيل حفاظاً على بياناتك. ` +
        `أزل البرنامج ثم أعد تثبيته.`,
    );
  }

  const provenance = await readDemoProvenance();
  if (!provenance) {
    throw new Error(
      `النسخة التجريبية لم تتعرّف على قاعدة البيانات «${file}» — فهي ليست النسخة التي ثبّتها البرنامج. ` +
        `تم إيقاف التشغيل حفاظاً على بياناتك. احذف هذا الملف ثم أعد تشغيل البرنامج ليُنشئ نسخته التجريبية.`,
    );
  }

  await assertSeedIsLoginable(file);

  log('database checked', {
    file,
    build: 'demo',
    seedId: provenance.seedId,
    seedBuiltAt: provenance.builtAt,
    loginVerified: PRIMARY_DEMO_LOGIN.username,
  });
}

/**
 * Refuses to serve a demo whose published credentials do not work.
 *
 * ── Why a login form you cannot log into is the worst outcome ────────────────
 *
 * Everything upstream of this checks that the database is the right *file*. None of it
 * checks the only thing the merchant actually does with it. A demo can pass every
 * structural gate — correct name, valid provenance marker, migrations current — and
 * still hand him a login box that refuses the credentials printed in his own
 * instructions. He then has no way to tell a broken build from a typo, and the honest
 * answer is available to us and not to him.
 *
 * So the check is the merchant's own action, performed before he can attempt it: the
 * documented password is verified against the stored hash of the documented username.
 * If it fails, the process refuses to start and the shell renders the reason — which
 * is strictly better than a form that cannot succeed.
 *
 * The password is verified, not merely looked for: a row can exist with a hash of
 * something else entirely, which is exactly the drift this is here to catch.
 */
async function assertSeedIsLoginable(file: string): Promise<void> {
  const { username, password } = PRIMARY_DEMO_LOGIN;

  const account = await prisma.user.findFirst({
    where: { username },
    select: { passwordHash: true, isActive: true },
  });

  if (!account) {
    throw new Error(
      `قاعدة البيانات التجريبية «${file}» لا تحتوي على حساب «${username}»، ` +
        `وهو الحساب المذكور في تعليمات التشغيل. تم إيقاف التشغيل بدل عرض شاشة دخول لا يمكن الدخول منها. ` +
        `احذف هذا الملف ثم أعد تشغيل البرنامج ليُنشئ نسخته التجريبية من جديد.`,
    );
  }

  if (!account.isActive) {
    throw new Error(
      `حساب «${username}» في قاعدة البيانات التجريبية «${file}» غير مفعّل، فلا يمكن الدخول به. ` +
        `احذف هذا الملف ثم أعد تشغيل البرنامج.`,
    );
  }

  if (!(await verifyPassword(account.passwordHash, password))) {
    throw new Error(
      `كلمة المرور المذكورة في تعليمات التشغيل لا تعمل على قاعدة البيانات التجريبية «${file}». ` +
        `تم إيقاف التشغيل بدل عرض شاشة دخول لا يمكن الدخول منها. ` +
        `احذف هذا الملف ثم أعد تشغيل البرنامج ليُنشئ نسخته التجريبية من جديد.`,
    );
  }
}

/**
 * Whether this demo database still carries the account the instructions publish.
 *
 * Used by the login route to tell a wrong password apart from a wrong database — the
 * two produce the same 401 today, and only one of them is the merchant's fault.
 */
export async function demoSeedHasPublishedAccount(): Promise<boolean> {
  if (!isDemoBuild()) return true;
  try {
    const row = await prisma.user.findFirst({
      where: { username: PRIMARY_DEMO_LOGIN.username },
      select: { id: true },
    });
    return row !== null;
  } catch {
    return true;
  }
}
