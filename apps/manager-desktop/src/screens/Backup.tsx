import { CloudOff, HardDrive, RotateCcw, Usb } from 'lucide-react';
import { locale } from '../lib/locale';
import { Button, Card, CardHeader, Chip, Notice, PageHeader } from '../components/ui';

/**
 * Backup settings (CLAUDE_v3.md §7.3).
 *
 * §5.1 accepted a real risk when it moved storage onto one machine: a disk failure,
 * a theft, or ransomware loses everything. Backup is therefore **mandatory, not
 * optional**, and this screen leads with that rather than burying it under
 * configuration.
 *
 * The Drive integration itself lands in V3-6 — it needs a Google Cloud project and
 * OAuth credentials, which is a one-time setup rather than something instant. The
 * status here says "not connected" plainly instead of showing a reassuring
 * placeholder, because a backup screen that looks healthy while backing nothing up
 * is worse than no screen at all.
 */
export function BackupScreen() {
  return (
    <>
      <PageHeader title={locale.backup.title} subtitle={locale.backup.subtitle} />

      <div className="mb-6">
        <Notice tone="danger" title="خطر فقدان البيانات">
          {locale.backup.riskNotice}
        </Notice>
      </div>

      {/* 3-2-1: three copies, two media, one off-site. Each leg gets its own row so
          a manager can see at a glance which are actually covered. */}
      <div className="space-y-6">
        <Card>
          <CardHeader
            title={locale.backup.driveTitle}
            subtitle={locale.backup.driveHint}
            action={<Chip tone="danger">{locale.backup.driveNotConnected}</Chip>}
          />
          <div className="flex items-center justify-between gap-6 p-6">
            <div className="flex items-center gap-3 text-steel">
              <CloudOff size={20} aria-hidden />
              <span className="text-sm">
                {locale.backup.lastBackup}: {locale.backup.never}
              </span>
            </div>
            <Button variant="secondary" disabled>
              {locale.common.comingSoon}
            </Button>
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-6">
          <Card>
            <CardHeader title={locale.backup.localTitle} />
            <div className="flex items-center gap-3 p-6 text-steel">
              <HardDrive size={20} aria-hidden />
              <span className="text-sm">
                {locale.backup.lastBackup}: {locale.backup.never}
              </span>
            </div>
          </Card>

          <Card>
            <CardHeader title={locale.backup.usbTitle} />
            <div className="flex items-center gap-3 p-6 text-steel">
              <Usb size={20} aria-hidden />
              <span className="text-sm">
                {locale.backup.lastBackup}: {locale.backup.never}
              </span>
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader title={locale.backup.restoreTitle} subtitle={locale.backup.restoreHint} />
          <div className="flex items-center justify-between gap-6 p-6">
            <div className="flex items-center gap-3 text-steel">
              <RotateCcw size={20} aria-hidden />
              <span className="text-sm">لم يُجرَ اختبار استعادة بعد</span>
            </div>
            <Button variant="secondary" disabled>
              {locale.common.comingSoon}
            </Button>
          </div>
        </Card>
      </div>

      <div className="mt-6">
        <Notice tone="warning">{locale.backup.scheduleHint}</Notice>
      </div>
    </>
  );
}
