import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyStagedRestore,
  confirmRestore,
  MAX_RESTORED_BOOTS,
  readRestoreResult,
  requestRollback,
  restoreDirectoryFor,
  rollbackSentence,
  sha256File,
  writeApplyRequest,
  writeStagedManifest,
} from '../lib/restore-apply';

/**
 * Putting a restored copy in place at boot (lib/restore-apply.ts).
 *
 * Plain files stand in for the database: the swap is pure filesystem, and what these
 * tests guard is ordering — that the previous set is never lost, that a cut mid-swap is
 * finished rather than papered over with an empty template, and that a copy the service
 * will not start on goes away again by itself.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const log = (): void => {};

function shop(): { live: string; restore: string } {
  const root = mkdtempSync(join(tmpdir(), 'walaa-apply-'));
  roots.push(root);
  const live = join(root, 'walaa.db');
  writeFileSync(live, 'OLD');
  // The WAL holds committed sales. It must travel with its database, in both directions.
  writeFileSync(`${live}-wal`, 'OLD-WAL');
  const restore = restoreDirectoryFor(live);
  mkdirSync(restore, { recursive: true });
  return { live, restore };
}

function stageAndRequest(restore: string, content = 'NEW'): void {
  const pending = join(restore, 'pending.db');
  writeFileSync(pending, content);
  writeStagedManifest(restore, {
    version: 1,
    stagedAt: new Date().toISOString(),
    stagedBy: null,
    stagedByName: 'مالك',
    source: { kind: 'local', label: 'نسخة محلية', id: 'x', name: 'walaa-x.walaabk' },
    copyTakenAt: '2026-09-01T10:00:00.000Z',
    latestActivityAt: null,
    copy: { customers: 3, transactions: 7, vouchers: 0, auditEntries: 9 },
    current: { customers: 5, transactions: 9 },
    upgraded: [],
    sha256: sha256File(pending),
    bytes: content.length,
  });
  writeApplyRequest(restore, {
    requestedAt: new Date().toISOString(),
    requestedBy: null,
    requestedByName: 'مالك',
    safetyBackupName: 'walaa-safety.walaabk',
  });
}

describe('applying a restore at startup', () => {
  it('does nothing when no restore was asked for', () => {
    const { live } = shop();
    expect(applyStagedRestore(live, log)).toBeNull();
    expect(readFileSync(live, 'utf8')).toBe('OLD');
  });

  it('swaps the checked copy in and keeps the previous set — database and WAL — aside', () => {
    const { live, restore } = shop();
    stageAndRequest(restore);

    const applied = applyStagedRestore(live, log);
    expect(applied).not.toBeNull();
    expect(readFileSync(live, 'utf8')).toBe('NEW');
    // No stale WAL beside the restored file: SQLite would try to replay it.
    expect(existsSync(`${live}-wal`)).toBe(false);

    const kept = join(restore, applied!.record.keptAs, 'walaa.db');
    expect(readFileSync(kept, 'utf8')).toBe('OLD');
    expect(readFileSync(`${kept}-wal`, 'utf8')).toBe('OLD-WAL');

    const result = confirmRestore(applied!, log);
    expect(result).toMatchObject({
      ok: true,
      safetyBackupName: 'walaa-safety.walaabk',
      copy: { customers: 3, transactions: 7 },
    });
    expect(readRestoreResult(restore)?.ok).toBe(true);
    // Nothing is left pending: the next start is an ordinary one.
    expect(applyStagedRestore(live, log)).toBeNull();
  });

  it('replaces nothing when the staged file changed after it was checked', () => {
    const { live, restore } = shop();
    stageAndRequest(restore);
    writeFileSync(join(restore, 'pending.db'), 'TAMPERED');

    expect(applyStagedRestore(live, log)).toBeNull();
    expect(readFileSync(live, 'utf8')).toBe('OLD');
    expect(readRestoreResult(restore)).toMatchObject({ ok: false });
    expect(readRestoreResult(restore)?.failure).toMatch(/لم يُستبدل شيء/);
  });

  it('puts the previous database back on the next start when the restored one would not start', () => {
    const { live, restore } = shop();
    stageAndRequest(restore);
    const applied = applyStagedRestore(live, log)!;

    requestRollback(applied, 'لم تعمل الخدمة على النسخة المستعادة', log);
    expect(applyStagedRestore(live, log)).toBeNull();

    expect(readFileSync(live, 'utf8')).toBe('OLD');
    expect(readFileSync(`${live}-wal`, 'utf8')).toBe('OLD-WAL');
    expect(readRestoreResult(restore)).toMatchObject({
      ok: false,
      failure: 'لم تعمل الخدمة على النسخة المستعادة',
    });
    // Its files are live again, so the kept folder is gone rather than left empty.
    expect(existsSync(join(restore, applied.record.keptAs))).toBe(false);
  });

  it('records only what went wrong from a startup refusal, not advice written for another situation', () => {
    // The sentence a live rollback recorded in full, markdown and all.
    const sentence = rollbackSentence(
      new Error(
        'تعذّر تشغيل الخدمة: قاعدة البيانات الموجودة على هذا الجهاز أنشأها إصدار مختلف من البرنامج (الإصدار 0.2.2)، ' +
          'وهذا الإصدار لا يستطيع فتحها. **إعادة تثبيت البرنامج لن تحل هذه المشكلة** لأن التثبيت لا يمسّ بيانات المتجر.',
      ),
    );

    expect(sentence).toContain('أنشأها إصدار مختلف من البرنامج (الإصدار 0.2.2)');
    expect(sentence).toMatch(/أُعيدت بيانات المتجر كما كانت/);
    expect(sentence).not.toContain('**');
    expect(sentence).not.toContain('إعادة تثبيت');
  });

  it("keeps a driver's English out of the recorded reason", () => {
    expect(rollbackSentence(new Error('SQLITE_CORRUPT: database disk image is malformed'))).not.toMatch(
      /[A-Za-z]/,
    );
  });

  it('finishes a swap a power cut interrupted, instead of leaving no database behind', () => {
    // The gap this whole design exists for: the old set moved aside, the copy not yet
    // moved in. Left alone, the next start finds no database and installs an EMPTY one.
    const { live, restore } = shop();
    stageAndRequest(restore);
    applyStagedRestore(live, log);
    renameSync(live, join(restore, 'pending.db'));
    expect(existsSync(live)).toBe(false);

    const resumed = applyStagedRestore(live, log);

    expect(readFileSync(live, 'utf8')).toBe('NEW');
    expect(resumed?.record.boots).toBe(2);
  });

  it('gives up on a restored database that keeps failing to start, and restores the previous one', () => {
    const { live, restore } = shop();
    stageAndRequest(restore);

    // Each call is a start that died hard — killed, not a caught failure — on the copy.
    let applied = applyStagedRestore(live, log);
    for (let boot = 1; boot < MAX_RESTORED_BOOTS; boot += 1) applied = applyStagedRestore(live, log);
    expect(applied).not.toBeNull();

    expect(applyStagedRestore(live, log)).toBeNull();
    expect(readFileSync(live, 'utf8')).toBe('OLD');
    expect(readRestoreResult(restore)?.ok).toBe(false);
  });
});
