# Meta WhatsApp inbound webhook — n8n bridge

> **Target stack:** Kairikos Chatbot AI end-client portal (Next.js 14 +
> Prisma + PostgreSQL 16).
> **Companion code (already shipped, not part of this flow):**
> `portal/src/app/api/internal/recall/whatsapp-reply/route.ts` and its
> sibling `portal/src/app/api/internal/channels/whatsapp/message/route.ts`
> — both already implement the actual business logic; this workflow only
> authenticates Meta and relays.
> **Companion runbook:** the "Recall + Reseñas Runbook" artifact, section
> 1a-bis, has the operator-facing version of this same contract.

## Why this exists

Meta's WhatsApp Cloud API delivers every inbound message (and every
status update) to one webhook URL you register in the Meta App
Dashboard. That URL cannot point at the portal directly — every other
platform integration in this repo goes through n8n first (n8n
interprets the external platform's shape; the portal decides what to do
with it), and the two portal routes above were built with that same
boundary in mind from day one. This flow is the missing piece: it *is*
the URL Meta calls, and it does nothing except authenticate the request
and relay it.

## Goals

- Serve Meta's one-time webhook verification handshake (`GET` with
  `hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`).
- Verify `X-Hub-Signature-256` on every `POST` before trusting the
  payload — HMAC-SHA256 of the **raw** body with `META_APP_SECRET`.
- Extract `phone_number_id` / sender / text from a genuine incoming text
  message; silently ack (200) anything else (status updates, non-text
  message types) rather than forwarding noise to the portal.
- Try `/api/internal/recall/whatsapp-reply` first; only call
  `/api/internal/channels/whatsapp/message` when the first one answers
  `handled: false` — mirrors the ordering `whatsapp-reply/route.ts`'s
  own header comment already documents as the intended contract.

## Non-goals

- Any actual message interpretation, matching, or reply logic — that's
  entirely inside the two portal routes. This flow never inspects
  `RecallDigest`, `RecallSubscription`, or any other portal data; it
  only relays `{phoneNumberId, from, text}`.
- Outbound sends (templates, digests, etc.) — unrelated, already
  covered by `portal/src/lib/whatsapp-api.ts` and `recall-messaging.ts`,
  called directly by the portal, not through n8n.

## The flow

Generate it with `npx tsx automations/meta-whatsapp-webhook/build-flows.ts`
and import via **n8n → Workflows → Import from File** (`meta-whatsapp-webhook.json`),
or push it via the API — see `import-to-n8n.mjs`.

```
[ Webhook — Verify (GET) ]  path: meta-whatsapp
   ↓
[ Check Verify Token ]      hub.verify_token === $env.META_WEBHOOK_VERIFY_TOKEN ?
   ↓ true                              ↓ false
[ Respond — Challenge OK ]  [ Respond — Verify Failed ]
   text: hub.challenge         403

[ Webhook — Events (POST) ] path: meta-whatsapp (same path, different method)
   ↓                                     rawBody: true
[ Verify Signature ]        HMAC-SHA256(raw body, META_APP_SECRET) vs X-Hub-Signature-256
   ↓
[ Check Signature Valid ]
   ↓ true                              ↓ false
[ Extract Message ]         [ Respond — Bad Signature ]  403
   ↓
[ Has Text Message? ]      (status updates / non-text types stop here)
   ↓ true                              ↓ false
[ POST .../recall/whatsapp-reply ]     [ Respond — No Message ]  200 {"status":"ignored"}
   ↓
[ Recall Handled? ]
   ↓ true                              ↓ false
[ Respond — Recall Handled ]  200      [ POST .../channels/whatsapp/message ]
                                           ↓
                                        [ Respond — Chatbot Handled ]  200
```

16 nodes total (verified by `smoke-meta-whatsapp-webhook.mjs`). Both
webhook triggers share one path — n8n scopes a webhook registration by
path *and* method independently, so Meta's single registered URL covers
both the GET handshake and every POST delivery after it.

## Why a `respondToWebhook` node, not `responseMode: 'lastNode'`

Every other webhook flow in this repo (see
`automations/portal-internal-activity/build-flows.ts`'s Tally trigger)
uses `responseMode: 'lastNode'` with a fixed JSON `responseData` — good
enough when the response body never changes. Meta's verification
handshake needs to echo back a *value only known at request time*
(`hub.challenge`) as **plain text**, not wrapped in JSON — `lastNode`
mode can't do that, so this flow uses explicit `respondToWebhook` nodes
on every branch instead, for consistency across both the GET and POST
sides.

## Environment variables (n8n side)

```
PORTAL_API_URL               # e.g. https://portal.kairikos.com
PORTAL_API_KEY               # shared with the portal's own PORTAL_API_KEY
META_APP_SECRET              # same value as the portal's META_APP_SECRET
                              #   (or whatever's saved at /admin/portal/settings/meta)
META_WEBHOOK_VERIFY_TOKEN    # any string YOU choose — must match EXACTLY
                              #   what you type into Meta's webhook config screen
```

None of these are n8n *credentials* (no OAuth, no vaulted secret type
needed) — plain environment variables, referenced via `$env.NAME` in
every node, same convention `wizard-lifecycle-triggers` already
established.

## Setting it up in Meta, once imported and activated

1. In the n8n editor, open the **"Webhook — Verify (GET)"** node and
   copy its **Production URL** (not the Test URL — Meta needs the
   workflow active).
2. In Meta App Dashboard → WhatsApp → Configuration → Webhooks:
   - **URL de devolución de llamada** = the URL from step 1.
   - **Token de verificación** = the exact same string you put in
     `META_WEBHOOK_VERIFY_TOKEN`.
3. Save. Meta immediately fires the GET handshake — if
   `META_WEBHOOK_VERIFY_TOKEN` doesn't match, Meta shows an error right
   there and nothing is subscribed.
4. Subscribe to the `messages` field for the WABA(s) you want inbound
   replies from.

## Verification (unverified against a real Meta app or a real n8n import)

Same standing caveat as every Meta integration built this cycle — the
node shapes follow this repo's own already-proven conventions, but this
hasn't run against real Meta traffic. Once imported and configured:

1. Send a real WhatsApp message to a connected client's number from the
   client's own phone.
2. Confirm in n8n's execution log that the run appears, the signature
   check passed, and the portal call returned 200.
3. For a digest-reply test specifically: check in Postgres that
   `RecallDigest.respondedAt` got stamped for that subscription.
4. Send an unrelated message (not a digest reply) from a number that
   isn't the owner's — confirm it falls through to
   `/api/internal/channels/whatsapp/message` (`Recall Handled?` took the
   `false` branch) instead of being silently dropped.

## Files in this folder

| File | Purpose |
|---|---|
| `build-flows.ts` | Generates the workflow JSON. Run after any change to this README's contract. |
| `meta-whatsapp-webhook.json` | Full export — import via the n8n UI. |
| `meta-whatsapp-webhook.api.json` | Stripped export for the REST API create endpoint — used by `import-to-n8n.mjs`. |
| `import-to-n8n.mjs` | Pushes the `.api.json` to a real n8n instance via its API. |
| `smoke-meta-whatsapp-webhook.mjs` | Contract assertions — node shape, path/method pairing, HMAC wiring, portal-route contract, reachability. Run after every regeneration. |
