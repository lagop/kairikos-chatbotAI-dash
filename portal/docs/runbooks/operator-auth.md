# Operator Auth Runbook (KAIA-1107)

## First login flow

1. Navigate to `/admin/portal`
2. You will be redirected to the login page at `/operator/login`
3. Enter your email and the initial password set during provisioning
4. On first login, you will be prompted to scan a QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.)
5. After scanning, enter the 6-digit code from the app to confirm enrollment
6. **Save the 8 recovery codes** displayed after enrollment. Store them in a password manager or offline safe. They will never be shown again.
7. On subsequent logins, enter email + password + TOTP code

## Reset password

If you lose access:
- Use a recovery code (from step 6 above) to authenticate
- Then set a new password via the settings page (KAIA-1084, once available)

## Recovery codes

- 8 one-time codes generated at TOTP enrollment
- Stored as argon2id hashes in the database (never plaintext)
- Each code can be used exactly once
- Shown only at enrollment — save them immediately
- Used as fallback when you lose your authenticator app

## Dev environment

The seed script creates a dev operator:

- Email: `ceo@kairikos.com`
- Dev password: `kairikos-dev-operator-2026`
- TOTP is NOT enrolled by default — enroll on first login
- This password is for DEV only and never used in production

To reseed (idempotent — won't overwrite existing rows):

```bash
npx prisma db seed
```

## Production deployment

1. Before going live, set `OPERATOR_TOTP_ENCRYPTION_KEY` to a secure random hex string:
   ```bash
   openssl rand -hex 32
   ```
2. Set `KAIA_OPERATOR_API_KEY` (legacy fallback) to a secure random hex string if you want the
   legacy path active during migration:
   ```bash
   openssl rand -hex 32
   ```
3. **Do not** use the dev password in production. Create the first operator manually or via
   seed with a temporary password that is changed on first login.
4. After all operators have migrated to session auth, remove the `KAIA_OPERATOR_API_KEY` env
   var and delete the legacy code path (tracked in a follow-up issue).

## Architecture notes

- Sessions are server-side, stored in `OperatorSession` table
- Session token is a UUIDv4, returned as httpOnly secure cookie
- Cookie name: `kairikos_operator_session`
- Session lifetime: 7 days absolute (not sliding)
- TOTP step-up: 5-minute window after TOTP verification for mutation access
- TOTP secrets encrypted at rest with AES-256-GCM (`OPERATOR_TOTP_ENCRYPTION_KEY`)
- Passwords hashed with argon2id (OWASP 2026 recommendation)
- Recovery codes stored as argon2id hashes

## API reference

### `POST /api/operator/login`

Authenticate with email and password.

Request:
```json
{ "email": "ceo@kairikos.com", "password": "..." }
```

Response (200, sets `kairikos_operator_session` cookie):
```json
{ "totpRequired": true }
```

Response (401):
```json
{ "error": "invalid_credentials" }
```

Response (429):
```json
{ "error": "too_many_requests" }
```

### `POST /api/operator/logout`

Revokes the current session. Response (200):
```json
{ "ok": true }
```

### `POST /api/operator/totp/enroll`

Two-phase enrollment.

**Phase 1 — generate secret** (no body):
Response (200):
```json
{ "uri": "otpauth://totp/Kairikos:ceo@kairikos.com?...", "step": "scan" }
```

**Phase 2 — verify code**:
Request:
```json
{ "code": "123456" }
```
Response (200):
```json
{ "recoveryCodes": ["abc123...", ...], "message": "Store these recovery codes..." }
```

### `POST /api/operator/totp/verify`

Verify TOTP code or recovery code for step-up.

Request:
```json
{ "code": "123456" }
```

Response (200):
```json
{ "ok": true, "method": "totp" }
```

Recovery code fallback:
```json
{ "ok": true, "method": "recovery_code" }
```

## Legacy migration

The `x-kaia-operator-key` header still works on all admin portal routes. Each use
logs a WARN to the server console with the IP and endpoint. Once the migration
cutover is confirmed (all operators using session auth for at least 1 week), the
legacy path can be removed.
