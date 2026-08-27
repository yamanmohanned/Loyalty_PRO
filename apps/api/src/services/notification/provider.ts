/**
 * The notification boundary (CLAUDE.md §3.5).
 *
 * Two realities this interface exists to encode:
 *
 * 1. **Business-initiated WhatsApp messages cannot be free-form.** Meta requires a
 *    pre-approved template, and you fill in variables. So the contract is a
 *    template name plus a variable map — never a message string. Code that builds
 *    prose here would be unshippable the moment it met the real API.
 *
 * 2. **The gateway will change.** Meta today, Twilio or a local aggregator
 *    tomorrow. Everything upstream depends on this interface, never on a vendor.
 */

/** Templates this platform sends. Names map to approved templates via env config. */
export const NOTIFICATION_TEMPLATES = {
  /** Sent at registration, carrying the customer's QR code. */
  WELCOME: 'WELCOME',
  /** Sent after an invoice is linked: amount, new balance, gap to next tier. */
  TRANSACTION_LINKED: 'TRANSACTION_LINKED',
  /** Sent when a threshold crossing earns a coupon. */
  COUPON_ISSUED: 'COUPON_ISSUED',
} as const;

export type NotificationTemplate =
  (typeof NOTIFICATION_TEMPLATES)[keyof typeof NOTIFICATION_TEMPLATES];

/**
 * Template variables. Deliberately a flat map of primitives: whatever the gateway,
 * a template variable is a string in the end.
 */
export type TemplateVariables = Record<string, string | number>;

export interface NotificationMessage {
  /** E.164. The only piece of PII that crosses this boundary. */
  to: string;
  template: NotificationTemplate;
  variables: TemplateVariables;
}

export interface NotificationResult {
  status: 'SENT' | 'FAILED' | 'STUBBED';
  /** The gateway's own message id, when it returns one. */
  providerMessageId?: string;
  error?: string;
}

export interface NotificationProvider {
  readonly id: string;
  send(message: NotificationMessage): Promise<NotificationResult>;
}
