import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Card, EmptyState, FailureReference } from './ui';
import { locale } from '../lib/locale';

/**
 * The backstop for a route that throws.
 *
 * **Written because one did.** The customer detail screen read `balance.totalSpend`
 * off an envelope the API had stopped sending, and the result was not a broken card
 * or a missing figure — it was a white screen for the whole application, with the
 * only explanation in a console the merchant will never open. React unmounts the
 * entire tree when a render throws and nothing catches it; there is no smaller
 * failure mode available by default.
 *
 * That specific bug is fixed at its source, and this exists because fixing one
 * instance is not a guarantee about the next one. What it can promise is that a throw
 * costs one route rather than the product.
 *
 * **Scope is deliberate: it wraps the routed content, not the shell.** The rail keeps
 * rendering, so the merchant can navigate away from a broken screen instead of
 * restarting the app — which is the difference between a fault and an outage.
 *
 * ── What it says, and why it changed ─────────────────────────────────────────
 *
 * It said «حدث خطأ / تعذّر تحميل هذه الصفحة» — on the Cards screen, on a machine whose
 * banner said the disk was nearly full, so the merchant reasonably blamed the disk. It
 * was a render defect (an icon passed as a component instead of an element) and would
 * have failed identically on an empty disk. A render throw is **always** a defect in
 * this program: the data arrived, the code could not draw it. So the message now names
 * the screen, says plainly that it is the program and not their data or their machine,
 * tells them what still works, and gives support a reference.
 *
 * The reference is real: the crash is posted to the service, which writes it to its own
 * log under that id — the one log support can actually be sent.
 */
export class RouteErrorBoundary extends Component<
  { screen: string; children: ReactNode; onReset?: () => void },
  { error: Error | null; reference: string | null }
> {
  override state: { error: Error | null; reference: string | null } = {
    error: null,
    reference: null,
  };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[route] render failed', error, info.componentStack);

    void api
      .post<{ reference: string }>('/system/client-errors', {
        screen: this.props.screen,
        message: String(error?.message ?? error).slice(0, 500),
        stack: `${error?.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 4000),
      })
      .then(({ reference }) => {
        // Only if this is still the error on screen — a retry may have cleared it.
        if (this.state.error === error) this.setState({ reference });
      })
      .catch(() => {
        /* The report is a courtesy to support. The message on screen stands without it. */
      });
  }

  private reset = () => {
    this.setState({ error: null, reference: null });
    this.props.onReset?.();
  };

  override render() {
    if (!this.state.error) return this.props.children;

    return (
      <Card>
        <EmptyState
          icon={<AlertTriangle size={22} aria-hidden />}
          title={locale.failure.crashTitle(this.props.screen)}
          body={locale.failure.crashBody}
          action={
            <div className="flex flex-col items-center gap-3">
              {this.state.reference ? <FailureReference value={this.state.reference} /> : null}
              <Button variant="ghost" onClick={this.reset}>
                {locale.common.retry}
              </Button>
            </div>
          }
        />
      </Card>
    );
  }
}
