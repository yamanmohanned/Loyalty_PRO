import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, Card, EmptyState } from './ui';
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
 * instance is not a guarantee about the next one. Every screen here reads data over
 * a network from a service that can be down, mid-restart, or a version out of step
 * with this build — so "no component will ever throw" is not a property this app can
 * promise. What it can promise is that a throw costs one route rather than the
 * product.
 *
 * **Scope is deliberate: it wraps the routed content, not the shell.** The rail keeps
 * rendering, so the merchant can navigate away from a broken screen instead of
 * restarting the app — which is the difference between a fault and an outage.
 */
export class RouteErrorBoundary extends Component<
  { children: ReactNode; onReset?: () => void },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept, because the message on screen is deliberately not a stack trace: the
    // merchant gets a sentence they can act on, and whoever is debugging gets this.
    console.error('[route] render failed', error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render() {
    if (!this.state.error) return this.props.children;

    return (
      <Card>
        <EmptyState
          icon={<AlertTriangle size={22} aria-hidden />}
          title={locale.common.error}
          body={locale.common.errorBody}
          action={
            <Button variant="ghost" onClick={this.reset}>
              {locale.common.retry}
            </Button>
          }
        />
      </Card>
    );
  }
}
