-- ============================================================
-- 037_template_message_preview.sql
--
-- messages.template_preview — the resolved header/body/footer/buttons
-- of an OUTBOUND template message at send time, so the inbox bubble can
-- render it exactly as it appears on the recipient's phone (buttons
-- included) instead of just the plain body text. Mirrors
-- interactive_payload (migration 035) but keeps its own column since
-- the shape is different (all four Meta button types, not just tappable
-- reply buttons) and only ever set for content_type = 'template'.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS template_preview JSONB;
