/**
 * Dev-only: put the backup key ceremony back to its first-run state
 * (CLAUDE_v3.md §12.19).
 *
 * The ceremony is deliberately one-way in normal use — that is the whole point of it —
 * so redoing it needs a tool that says out loud what it is doing. Two things make the
 * manager app show the gate again:
 *
 *  1. **No confirmation for any key**, which is what `everConfirmed` reads. Confirmations
 *     are audit rows keyed on a key's fingerprint, so they are cleared here.
 *  2. **No key configured**, so the ceremony starts from "generate" rather than from
 *     "confirm the one already there".
 *
 * Refuses to run in production. Clearing audit rows on a merchant's machine would be
 * destroying the answer to "who has the key", which is a question a shop may need years
 * later — and the audit trail is append-only for exactly that reason (§7.10).
 */

import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/config/env';
import { setEnvValue } from '../src/config/env-file';
import { AUDIT_ACTIONS } from '../src/services/audit.service';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') {
    throw new Error('reset-ceremony لا يعمل في بيئة الإنتاج — سجل التدقيق للإلحاق فقط');
  }

  const cleared = await prisma.auditLog.deleteMany({
    where: {
      entityType: 'backup_key',
      action: {
        in: [
          AUDIT_ACTIONS.BACKUP_KEY_GENERATED,
          AUDIT_ACTIONS.BACKUP_KEY_CONFIRMED,
          AUDIT_ACTIONS.BACKUP_KEY_REVEALED,
        ],
      },
    },
  });

  let keyCleared = false;
  if (env.BACKUP_KEY?.trim()) {
    // Blanked rather than removed, so the line stays in the file as documentation of
    // what belongs there. An empty value parses as "not configured".
    setEnvValue('BACKUP_KEY', '', { overwrite: true });
    keyCleared = true;
  }

  const key = keyCleared ? 'أُفرغ من .env' : 'لم يكن مضبوطاً';

  // eslint-disable-next-line no-console -- a dev script reports to the operator by design
  console.log(`
  ✔ أُعيدت خطوة مفتاح النسخ الاحتياطي إلى حالة التشغيل الأول

    سجلات التدقيق المحذوفة   ${cleared.count}
    مفتاح التشفير            ${key}

    أعد تشغيل خادم API ثم افتح تطبيق الإدارة — ستظهر الخطوة من جديد.
`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
