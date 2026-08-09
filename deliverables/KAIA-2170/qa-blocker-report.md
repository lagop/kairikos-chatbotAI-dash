## QA Sign-off — BLOCKER: staging Vercel deployment is stale

The Vercel preview at `https://project-fxidg.vercel.app` is serving the **pre-credentials (magic-link) build**, not the KAIA-2168 + KAIA-2169 credentials-auth build. QA cannot sign off against a deployment that doesn't contain the change under test.

### Evidence

#### 1. `/portal/login` still renders the magic-link form

```
$ curl -sI https://project-fxidg.vercel.app/portal/login
HTTP/2 200
server: Vercel
x-matched-path: /portal/login
```

Body excerpt (from the deployed HTML):
```html
<label>Tu email de cliente</label>
<input type="email" placeholder="tu@negocio.es">
<button type="submit">Enviar enlace mágico</button>
<p>Te enviaremos un enlace de acceso a tu email. No necesitas recordar contraseña.</p>
```

Meta description (still references magic link):
```
<meta name="description" content="Inicia sesión en el portal de cliente Kairikos
con un enlace mágico a tu email.">
```

Expected after KAIA-2168 + KAIA-2169: email + password fields with `data-testid="password-input"` and a submit button labeled "Iniciar sesión".

#### 2. NextAuth providers endpoint shows only `nodemailer`

```
$ curl -s https://project-fxidg.vercel.app/api/auth/providers
{"nodemailer":{"id":"nodemailer","name":"Nodemailer","type":"email",
"signinUrl":"https://project-fxidg.vercel.app/api/auth/signin/nodemailer",
"callbackUrl":"https://project-fxidg.vercel.app/api/auth/callback/nodemailer"}}
```

Expected after KAIA-2168: `portal-credentials` and `admin-credentials` providers listed.

#### 3. New routes return 404 on staging

```
$ curl -sI https://project-fxidg.vercel.app/admin/login
HTTP/2 404
last-modified: Fri, 19 Jun 2026 10:21:47 GMT

$ curl -sI https://project-fxidg.vercel.app/portal/setup-password
HTTP/2 404

$ curl -sI https://project-fxidg.vercel.app/portal/forgot-password
HTTP/2 404
```

All three routes required by the KAIA-2103 plan §3.3 (`/admin/login`, `/portal/setup-password`, `/portal/forgot-password`) are missing on the deployed preview.

#### 4. `/admin/portal` redirect chain still routes through the old login

```
$ curl -sI https://project-fxidg.vercel.app/admin/portal
HTTP/2 307
location: /portal/login?next=/admin/portal
```

The admin portal guard redirects to the (magic-link) client login — there's no `/admin/login` to redirect to, so the redirect is still landing on the old client-side flow.

### Root cause

The `last-modified` header on the static 404 pages is `Fri, 19 Jun 2026 10:21:47 GMT`. The Vercel preview deployment is from June 19 — **before** KAIA-2168 and KAIA-2169 were merged. The child issues were marked `done` in Paperclip, but the corresponding changes were not promoted to the Vercel preview environment that KAIA-2170 was told to test against.

### What QA verified independently

The worktree code (portal/src/app/portal/login/page.tsx + LoginForm.tsx + AdminLoginForm.tsx + auth.ts) does contain the new Credentials auth:

- `auth.ts` exports two Credentials providers (`portal-credentials`, `admin-credentials`)
- `LoginForm.tsx` calls `signIn('portal-credentials', { email, password, redirect: false })`
- `AdminLoginForm.tsx` calls `signIn('admin-credentials', { email, password, redirect: false })`
- Password input has `data-testid="password-input"`
- Both forms have a "Forgot password?" link → `/portal/forgot-password` or `/admin/forgot-password`

So the code is correct. The deployment is the problem.

### Unblock action

The CTO ([KAIA-2103-4]) needs to deploy the merged feat/2103-backend + feat/2103-frontend branches to the Vercel preview so the staging URL reflects the new auth. Once that deploy lands, QA re-runs the full §4.3 sign-off against the updated preview.

artifact: /paperclip/instances/default/projects/fe217b5c-badf-4f17-ab20-f089478a35c7/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4/_default/deliverables/KAIA-2170/staging-evidence.txt