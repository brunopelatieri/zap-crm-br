import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './defaults';

// SPEC 049 §5.6 — the prompt must not promise a UI the resolved channel
// can't render.
describe('buildSystemPrompt — channel awareness (SPEC 049 §5.6)', () => {
  it('omitted channelType: no restriction guideline (unchanged prompt)', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).not.toContain('cannot render buttons');
  });

  it('whatsapp_cloud: no restriction guideline — the channel renders buttons fine', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      channelType: 'whatsapp_cloud',
    });
    expect(prompt).not.toContain('cannot render buttons');
  });

  it('whatsapp_qr: adds the plain-text-only guideline', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      channelType: 'whatsapp_qr',
    });
    expect(prompt).toContain('cannot render buttons');
    expect(prompt).toContain('numbered plain-text list');
  });

  it('applies in both draft and auto_reply modes', () => {
    for (const mode of ['draft', 'auto_reply'] as const) {
      const prompt = buildSystemPrompt({
        userPrompt: null,
        mode,
        channelType: 'whatsapp_qr',
      });
      expect(prompt).toContain('cannot render buttons');
    }
  });
});
