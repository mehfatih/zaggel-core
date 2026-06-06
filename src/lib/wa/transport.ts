// WhatsApp transport (S4, ADR-0010 — Meta Cloud API direct).
//
// An interface with two implementations:
//   - MetaCloudTransport: real Graph API calls (used when an org has a phone
//     number id + access token configured in wa_settings).
//   - LoggingTransport: dev/no-op — logs and returns a synthetic id, so the stack
//     boots, tests run, and the DoD demo works without a live WhatsApp number.
//
// `getTransport` picks per resolved org settings. Senders treat every call as
// best-effort (see messages.ts) — a transport failure never breaks the order path.

import { env } from '../env.js';

export interface SendResult {
  providerMessageId: string | null;
}

export interface TemplateComponentParam {
  type: 'body';
  parameters: Array<{ type: 'text'; text: string }>;
}

export interface WaTransport {
  readonly mode: 'meta' | 'log';
  /** Send an approved template message (outside the 24h window). */
  sendTemplate(to: string, name: string, language: string, bodyParams: string[]): Promise<SendResult>;
  /** Send a free-form text (only valid inside the 24h customer-service window). */
  sendText(to: string, body: string): Promise<SendResult>;
}

export interface ResolvedWaCreds {
  phoneNumberId: string;
  accessToken: string;
}

class MetaCloudTransport implements WaTransport {
  readonly mode = 'meta' as const;
  constructor(private readonly creds: ResolvedWaCreds) {}

  private url(): string {
    return `https://graph.facebook.com/${env.waGraphVersion}/${this.creds.phoneNumberId}/messages`;
  }

  private async post(payload: Record<string, unknown>): Promise<SendResult> {
    const res = await fetch(this.url(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.creds.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`wa_send_failed:${res.status}:${text.slice(0, 300)}`);
    }
    const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }> };
    return { providerMessageId: json.messages?.[0]?.id ?? null };
  }

  sendTemplate(to: string, name: string, language: string, bodyParams: string[]): Promise<SendResult> {
    const components: TemplateComponentParam[] =
      bodyParams.length > 0
        ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
        : [];
    return this.post({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name, language: { code: language }, components },
    });
  }

  sendText(to: string, body: string): Promise<SendResult> {
    return this.post({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
  }
}

class LoggingTransport implements WaTransport {
  readonly mode = 'log' as const;
  private n = 0;

  private synthId(): string {
    this.n += 1;
    return `wamid.dev-${this.n}`;
  }

  sendTemplate(to: string, name: string, _language: string, bodyParams: string[]): Promise<SendResult> {
    if (!env.isProd) {
      // eslint-disable-next-line no-console
      console.log(`[wa:log] template ${name} → ${to} :: ${bodyParams.join(' | ')}`);
    }
    return Promise.resolve({ providerMessageId: this.synthId() });
  }

  sendText(to: string, body: string): Promise<SendResult> {
    if (!env.isProd) {
      // eslint-disable-next-line no-console
      console.log(`[wa:log] text → ${to} :: ${body.slice(0, 120)}`);
    }
    return Promise.resolve({ providerMessageId: this.synthId() });
  }
}

/** Real transport when creds are present; logging no-op otherwise. */
export function getTransport(creds: ResolvedWaCreds | null): WaTransport {
  return creds ? new MetaCloudTransport(creds) : new LoggingTransport();
}
