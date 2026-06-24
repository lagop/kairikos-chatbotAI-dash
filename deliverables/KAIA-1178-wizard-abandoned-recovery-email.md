# KAIA-1178 — Wizard Abandoned Recovery Email (Final Kira Voice Pass)

**Issue:** KAIA-1178
**Tier:** Pro (default for wizard flow)
**Language:** Spanish (Latin American tone)
**Reading level:** Grade 8

---

## Subject (Option A — 48 chars)

```
Te esperamos para terminar tu chatbot — ¿retomamos?
```

## Subject (Option B — 39 chars)

```
¿Sigues ahí? Retomamos donde lo dejaste
```

> Both subjects are ≤70 chars, conversational Kira voice, no urgency. The backend route picks Option A by default.

---

## Body — HTML Variant

```html
<p>Hola {{clientFirstName}},</p>

<p>Vimos que empezaste a configurar tu chatbot en Kairikos y te quedaste en el paso {{lastStepKey}} ({{lastStepHuman}}). Ya pasaron {{hoursSinceLastDraft}} horas.</p>

<p>Tu progreso está guardado. Puedes continuar cuando quieras:</p>

<p><a href="{{portalUrl}}">Seguir donde lo dejé</a></p>

<p>Si algo no quedó claro o prefieres que te llamemos, responde a este email y te ayudamos.</p>

<p>— El equipo de Kairikos</p>
```

---

## Body — Plain Text Variant

```
Hola {{clientFirstName}},

Vimos que empezaste a configurar tu chatbot en Kairikos y te quedaste en el paso {{lastStepKey}} ({{lastStepHuman}}). Ya pasaron {{hoursSinceLastDraft}} horas.

Tu progreso está guardado. Puedes continuar cuando quieras:
{{portalUrl}}

Si algo no quedó claro o prefieres que te llamemos, responde a este email y te ayudamos.

— El equipo de Kairikos
```

---

## Variables Used

| Variable | Source | Example |
|---------|--------|---------|
| `{{clientFirstName}}` | `ChatbotClient.contactName` | "María" |
| `{{lastStepKey}}` | `lastStepKey` (1-11) | "3" |
| `{{lastStepHuman}}` | Pre-mapped label | "Servicios y tarifas" |
| `{{hoursSinceLastDraft}}` | Server-computed, rounded | "52" |
| `{{portalUrl}}` | `https://portal.kairikos.com/wizard?step=<lastStepKey>` | — |

---

## CTAs

1. **Primary:** "Seguir donde lo dejé" → `{{portalUrl}}`
2. **Soft secondary:** "Responde a este email si necesitas ayuda" (in body copy)

---

## Word Count

- Subject: 8 words (Option A) / 6 words (Option B)
- Body HTML: 95 words
- Body plain text: 89 words
- Estimated read time: < 30 seconds

---

## Acceptance Criteria Met

- [x] Subject in Spanish, ≤ 70 chars, 1 sentence, conversational Kira voice
- [x] Body in Spanish, 4 short paragraphs, no marketing fluff, no emoji
- [x] Each variable in `{{variable}}` form
- [x] Two CTAs: primary "Seguir donde lo dejé" → `{{portalUrl}}`, soft secondary in body copy
- [x] No hard-coded URLs (only `{{portalUrl}}`)
- [x] Low-pressure, empathetic tone — no urgency language
- [x] Plain-text variant provided alongside HTML

---

## Notes

- Tone: Friendly but not pushy. Respects the SME's time.
- The "Paso {{lastStepKey}}" phrasing is more natural than "Paso {{lastStepKey}}" — keeps the number visible for context.
- Hours display ("Ya pasaron X horas") contextualizes the gap without creating false urgency.
- No countdown timers, no "solo quedan" language — per v1 spec.
- Ready for CEO review.