import { describe, it, expect } from 'vitest';
import { parseWebhook } from '../inbound.js';

describe('parseWebhook', () => {
  it('flattens a text message with the receiving phone number id', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1234567890' },
                messages: [{ id: 'wamid.A', from: '9647700000000', type: 'text', text: { body: 'إيقاف' } }],
              },
            },
          ],
        },
      ],
    };
    const changes = parseWebhook(body);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ phoneNumberId: '1234567890' });
    expect(changes[0]!.messages[0]).toMatchObject({ id: 'wamid.A', from: '9647700000000', kind: 'text', text: 'إيقاف' });
  });

  it('extracts template quick-reply button payloads', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1' },
                messages: [{ id: 'wamid.B', from: '964', type: 'button', button: { payload: 'ZAGGEL_CONFIRM', text: 'تأكيد ✅' } }],
              },
            },
          ],
        },
      ],
    };
    const m = parseWebhook(body)[0]!.messages[0]!;
    expect(m.kind).toBe('button');
    expect(m.payload).toBe('ZAGGEL_CONFIRM');
  });

  it('extracts interactive button_reply ids', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '1' },
                messages: [{ id: 'wamid.C', from: '964', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'ZAGGEL_CANCEL', title: 'إلغاء ❌' } } }],
              },
            },
          ],
        },
      ],
    };
    const m = parseWebhook(body)[0]!.messages[0]!;
    expect(m.kind).toBe('button');
    expect(m.payload).toBe('ZAGGEL_CANCEL');
  });

  it('ignores status-only / malformed payloads', () => {
    expect(parseWebhook({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '1' }, statuses: [{ id: 'x' }] } }] }] })).toHaveLength(0);
    expect(parseWebhook({})).toHaveLength(0);
    expect(parseWebhook(null)).toHaveLength(0);
  });
});
