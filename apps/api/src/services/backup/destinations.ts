import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where backups go (docs/legacy/CLAUDE_v3.md §7.3).
 *
 * §7.3 asks for 3-2-1: Drive, plus a local copy, plus an external USB copy. "One medium
 * is never enough" is the requirement, and it has a consequence the interface has to
 * carry: **partial success is the normal case, not an error**. The USB stick is out of
 * the machine most of the day; the internet is down for an hour. A backup run that
 * treats any single destination failure as a failed backup will be reported as broken so
 * often that the merchant stops reading the reports — which is how the most-skipped step
 * in §7.3 gets skipped.
 *
 * So each destination reports for itself, the run records every outcome, and the
 * question a manager gets asked is "how many copies does your newest backup have", not
 * "did the backup work".
 */

export type DestinationKind = 'local' | 'usb' | 'drive';

export interface StoredBackup {
  /** Identifier at this destination — a filename locally, a file id on Drive. */
  id: string;
  name: string;
  bytes: number;
  createdAt: Date;
}

export interface BackupDestination {
  readonly kind: DestinationKind;
  /** Shown to the operator, e.g. the USB drive letter. */
  readonly label: string;

  /**
   * Whether this destination can be written to right now.
   *
   * Its own method rather than a failed `put`, because "the USB stick is not plugged in"
   * is an ordinary fact to report next to a green local copy, not an incident.
   */
  isAvailable(): Promise<boolean>;

  put(localPath: string, name: string): Promise<StoredBackup>;
  list(): Promise<StoredBackup[]>;
  fetch(id: string, localPath: string): Promise<void>;

  /** Deletes all but the `keep` newest. Returns what it removed. */
  prune(keep: number): Promise<string[]>;
}

/** Archive filename for a moment in time. Sorts chronologically as a string. */
export function archiveName(at: Date): string {
  return `walaa-${at.toISOString().replace(/[:.]/g, '-')}.walaabk`;
}

const ARCHIVE_SUFFIX = '.walaabk';

/**
 * A directory on this machine or on removable media.
 *
 * Serves both the local copy and the USB copy of §7.3 — they differ only in path and in
 * how often the volume is actually present, which `isAvailable` already expresses.
 */
export class LocalDirectoryDestination implements BackupDestination {
  constructor(
    readonly kind: DestinationKind,
    private readonly directory: string,
    readonly label: string = directory,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      // The PARENT is what tells us the volume is mounted. Checking the backup directory
      // itself would report "unavailable" for a USB stick that is plugged in and simply
      // has not been used before — which `put` would have created on its own.
      await mkdir(this.directory, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async put(localPath: string, name: string): Promise<StoredBackup> {
    await mkdir(this.directory, { recursive: true });
    const target = join(this.directory, name);

    // Copied to a temporary name and renamed, so a run interrupted halfway — the USB
    // pulled out mid-write is the realistic one — never leaves a truncated file sitting
    // in the directory looking like a backup.
    const staging = `${target}.partial`;
    await copyFile(localPath, staging);
    const { rename } = await import('node:fs/promises');
    await rename(staging, target);

    const { size, birthtime, mtime } = await stat(target);
    return { id: name, name, bytes: size, createdAt: birthtime ?? mtime };
  }

  async list(): Promise<StoredBackup[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }

    const found: StoredBackup[] = [];
    for (const name of names) {
      if (!name.endsWith(ARCHIVE_SUFFIX)) continue;
      const { size, birthtime, mtime } = await stat(join(this.directory, name));
      found.push({ id: name, name, bytes: size, createdAt: birthtime ?? mtime });
    }

    // Newest first. Sorted by NAME, not by filesystem timestamp: `archiveName` encodes
    // the instant, and copying a backup onto a USB stick resets its birthtime to the
    // moment of the copy, which would order a restored folder by when it was last
    // handled rather than by what it contains.
    return found.sort((a, b) => b.name.localeCompare(a.name));
  }

  async fetch(id: string, localPath: string): Promise<void> {
    await copyFile(join(this.directory, this.safeName(id)), localPath);
  }

  async prune(keep: number): Promise<string[]> {
    const all = await this.list();
    const doomed = all.slice(keep);
    for (const backup of doomed) {
      await rm(join(this.directory, backup.name), { force: true });
    }
    return doomed.map((b) => b.name);
  }

  /**
   * Rejects an id that is not a plain archive filename.
   *
   * `fetch` takes an id that reached the API from a client, and joining `../../` onto a
   * directory would read any file the service account can see. The ids this destination
   * issues are always `archiveName()` output, so anything else is either a bug or an
   * attempt.
   */
  private safeName(id: string): string {
    if (!/^[\w.-]+$/.test(id) || !id.endsWith(ARCHIVE_SUFFIX) || id.includes('..')) {
      throw new Error('اسم ملف النسخة الاحتياطية غير صالح');
    }
    return id;
  }
}
