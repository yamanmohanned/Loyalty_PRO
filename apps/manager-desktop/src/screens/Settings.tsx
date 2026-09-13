import { useEffect, useState } from 'react';
import { Settings as SettingsIcon, MonitorSmartphone, Network } from 'lucide-react';
import { getLocalApiUrl, getRemoteApiUrl } from '../lib/config';
import { readBackendStatus, type BackendStatus } from '../lib/backend';
import { locale } from '../lib/locale';
import { Card, CardHeader, Chip, Notice, PageHeader } from '../components/ui';
import { ServerAddressForm } from '../components/ServerAddressForm';
import { DriveSection } from './settings/DriveSection';
import { StaffSection } from './settings/StaffSection';

/**
 * Settings — the one place technical configuration lives.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Two machines, two opposite things to say
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The **manager PC** runs the service. The installer put it there, registered it with
 * the Service Control Manager and fixed its port. It has nothing to configure, and the
 * first section says exactly that — a statement of fact, not a form. Presenting it as
 * a form was the original defect: a question put to a machine that already knew the
 * answer, on the way in, every launch.
 *
 * A **second machine** — another manager workstation, or a PC beside the till — has to
 * be told which machine to talk to. That is the second section, and it is the only
 * place in the product where an address is typed on the happy path.
 *
 * Both are here, off the daily path, rather than on the login screen. What a shop
 * owner sees while signing in is a username and a password.
 *
 * ── The Station's address is information, not configuration ─────────────────
 *
 * The one address a merchant genuinely needs to read is the one he types into the
 * tablet at the till. It is shown here because somebody has to type it somewhere else;
 * it is not shown on the login screen, because the person signing in is sitting at the
 * machine it names.
 */
export function SettingsScreen() {
  const [local, setLocal] = useState<string | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  /** Re-read after the form saves, so the sections agree with each other. */
  const refresh = () => {
    void (async () => {
      const [l, r, s] = await Promise.all([
        getLocalApiUrl(),
        getRemoteApiUrl(),
        readBackendStatus(),
      ]);
      setLocal(l);
      setRemote(r);
      setStatus(s);
      setLoaded(true);
    })();
  };

  useEffect(refresh, []);

  /*
    Three states, and they are genuinely different to the merchant:

      running   — this machine hosts the service and it is up. Nothing to do.
      stopped   — this machine hosts it and it is not up. Restarting is the remedy.
      no server — this machine hosts nothing. Either it is not the manager PC (bind it
                  below) or the installation is broken (restart, then support).

    The third is distinguished from the second on purpose. "Stopped" tells someone to
    restart a thing that exists; saying it about a machine that never had a service
    sends them looking for something that was never there.
  */
  /*
    From the shell's report of what is INSTALLED, not from whether a port resolved.
    `local !== null` was a proxy: a manager PC whose service had not published its port
    — the missing-`walaa.env` case — read as "this machine hosts nothing", which is the
    same wrong inference `BackendGate` used to make. The port is the fallback only where
    there is no shell to ask.
  */
  const hosts = status?.hostsService ?? local !== null;
  const running = status?.state === 'running' || status?.state === 'starting';

  return (
    <>
      <PageHeader
        icon={<SettingsIcon size={24} aria-hidden />}
        title={locale.settings.title}
        subtitle={locale.settings.subtitle}
      />

      <Card>
        <CardHeader title={locale.settings.server.localTitle} />
        <div className="space-y-5 p-6">
          {!loaded ? (
            <p className="text-steel">{locale.common.loading}</p>
          ) : hosts ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-md bg-accent-tint text-accent">
                  <MonitorSmartphone size={20} aria-hidden />
                </span>
                <Chip tone={running ? 'success' : 'warning'}>
                  {running
                    ? locale.settings.server.localRunning
                    : locale.settings.server.localStopped}
                </Chip>
              </div>

              <p className="max-w-prose leading-relaxed text-ink">
                {locale.settings.server.localBody}
              </p>

              {/*
                The address for the till tablet.

                Deliberately the LAN-facing form rather than the loopback one the
                dashboard itself uses: `127.0.0.1` is correct for this process and
                useless on the tablet, and handing a merchant an address that cannot
                work from the device he is about to type it into is worse than handing
                him none. The host part is left for him to read off the machine,
                because this process cannot know which of its network interfaces the
                shop's tablet can see.
              */}
              <div>
                <p className="mb-2 text-sm font-medium text-ink">
                  {locale.settings.server.stationLabel}
                </p>
                <p className="rounded-md border border-border bg-canvas px-4 py-3">
                  {/* Latin text in an RTL paragraph: isolated, or the scheme and the
                      port swap ends. */}
                  <bdi dir="ltr" className="font-mono text-ink">
                    http://&lt;عنوان جهاز المدير&gt;:{status?.port ?? '—'}
                  </bdi>
                </p>
                <p className="mt-2 text-sm leading-relaxed text-steel">
                  {locale.settings.server.stationHint}
                </p>
              </div>
            </>
          ) : (
            <Notice tone="warning" title={locale.settings.server.localUnknown}>
              {locale.settings.server.localUnknownBody}
            </Notice>
          )}
        </div>
      </Card>

      <div className="mt-6">
        <Card>
          <CardHeader title={locale.settings.server.remoteTitle} />
          <div className="space-y-5 p-6">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-md bg-accent-tint text-accent">
                <Network size={20} aria-hidden />
              </span>
              <p className="max-w-prose leading-relaxed text-steel">
                {locale.settings.server.remoteBody}
              </p>
            </div>

            {/* `key` on the configured value so the form re-reads its initial state
                after a save or a reset, rather than holding the value it started with. */}
            <ServerAddressForm key={remote ?? 'local'} onSaved={refresh} />
          </div>
        </Card>
      </div>

      {/* The till's login — and everything else a person signs in with.

          FIRST among the one-time arrangements, because it is the one without which
          the shop cannot trade: the Loyalty Station is where the whole core loop lives
          and it had no account it could ever be signed into. */}
      <div className="mt-6">
        <StaffSection />
      </div>

      {/* Cloud backup sits beside the server settings for the reason the brief gives:
          both are one-time technical arrangements, and neither belongs on the path a
          merchant walks every morning. */}
      <div className="mt-6">
        <DriveSection />
      </div>
    </>
  );
}
