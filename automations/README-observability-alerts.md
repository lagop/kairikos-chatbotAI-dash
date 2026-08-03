# Observability alerts template

Reusable definitions are in `automations/observability-alerts-template.json`.

## Inputs

- `system_events`: service-role Supabase table containing event type, severity, payload, and timestamp.
- Owner billing overview endpoint for daily MRR, new clients, and cancellations.
- n8n secret-store entries: `SLACK_ERROR_WEBHOOK_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` (required). `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID` are optional drop-in fallbacks; the flows auto-upgrade to Telegram when present.

## Flows

- Stripe webhook failures: poll every minute; alert at 2 failures in 5 minutes.
- Reviews workflow failures: poll every minute; alert at 3 failures in 10 minutes.
- Daily summary: 09:00 Europe/Madrid.
- Supabase Edge Functions: poll every 5 minutes; alert above 1% errors in the rolling hour.

All alerts require idempotent fingerprint-based deduplication, bounded retries, and a system-event error path. Import the JSON into n8n, map the query nodes to the Supabase credential, and map the Telegram node to the Paperclip secret-store credential.
