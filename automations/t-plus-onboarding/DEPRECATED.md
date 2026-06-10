DEPRECATED — see automations/portal-internal-activity/ for the current flows (KAIA-756).

The four workflow JSONs in this folder (now in `archive/`) target the
Supabase `chatbot_activity` table via PostgREST, which is no longer the
data source for the end-client portal. The portal now reads from
Prisma `ChatbotActivity` (plan rev 3, KAIA-752). The replacement
flows live in `automations/portal-internal-activity/`.

**Do not import these files into n8n.** The JSON `name` field is
prefixed `[DEPRECATED — use portal-internal-activity]` so any accidental
import is visible at a glance in the n8n UI.

Retired in [KAIA-761](/KAIA/issues/KAIA-761). Original issue
[KAIA-734](/KAIA/issues/KAIA-734) is now `cancelled`. Replacement files:
`automations/portal-internal-activity/t-0-portal.json`,
`t-3-portal.json`, `t-7-portal.json`, `t-14-portal.json`.
