This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## KINO local model

KINO uses an optimized Ollama model alias with the same Qwen 3.5 4.3B Q4 weights and a compact, non-duplicated system prompt. Create the alias once before starting the app:

```bash
ollama create kino-optimized -f Modelfile.kino-optimized
```

To select another installed Ollama model, set `OLLAMA_MODEL` in `.env.local`.

KINO requests an 8192-token context window and caps each Ollama round at 1024 generated tokens. Override these reviewable per-request defaults with `KINO_NUM_CTX` and `KINO_NUM_PREDICT` in `.env.local`. This does not modify or recreate the installed Ollama model; the checked-in Modelfile remains the source configuration for manual model creation.

The application keeps KINO loaded in memory to avoid cold-start delays. Run `ollama stop kino-optimized` when you want Ollama to release the model memory.

## Private runtime state

KINO keeps short-lived local web-operation state under the private
.kino/runtime directory, which is Git ignored. Pending actions expire after
five minutes. Read-only form drafts expire after fifteen minutes and may
contain user-provided draft values, so the runtime files are written atomically
with private file permissions and must not be copied into source control or
diagnostic logs. Form drafts contain semantic field metadata only—never browser
selectors, DOM handles, cookies, session state, or current form values.

## General browser operator

KINO's Next.js controller and its persistent Playwright runtime are separate
processes. The Vercel application imports only a lightweight HTTP client;
Chromium, page locators, cookies, and authentication state stay in the browser
worker. Arbitrary public HTTP(S) URLs do not require a `.kino/connections`
record. Saved connections are legacy/optional convenience data only.

Copy the browser-related values from `.env.example` into `.env.local`, choose a
long random shared token, and use the same token in the Next.js and worker
environments. Never prefix this token with `NEXT_PUBLIC_`.

Start the persistent worker in a separate terminal:

```bash
npm run browser-worker
```

The worker defaults to `127.0.0.1:8787`, requires Bearer authentication on all
`/browser/*` endpoints, keeps one runtime-only BrowserContext per KINO
conversation, and expires inactive sessions. Its API is:

- `GET /health`
- `POST /browser/open`
- `POST /browser/observe`
- `POST /browser/action`
- `POST /browser/login`
- `POST /browser/close`

For a remote worker, set `KINO_BROWSER_WORKER_URL` to its private HTTPS address
and protect it with network controls in addition to the Bearer token.

### URL safety

Only public HTTP(S) navigation is allowed. KINO rejects embedded URL
credentials, non-web protocols, localhost/internal hostnames, private,
loopback, link-local, carrier-grade NAT, documentation/reserved networks, and
cloud metadata targets. DNS results and every main-frame redirect are checked.
`KINO_BROWSER_ALLOW_PRIVATE_NETWORKS=true` is a development-only escape hatch
and has no effect when `NODE_ENV=production`.

### Secure login

When the trusted page observer finds a login form, the KINO UI displays
dedicated username and password fields. They are posted to
`/api/kino/browser-login`, forwarded server-to-server to `/browser/login`, used
only by the worker to fill the discovered login form, and removed from request
objects/references after use. They are never added to chat history, Ollama
messages, model tool arguments, logs, API responses, or plaintext files.
Authenticated cookies remain only inside the runtime BrowserContext. CAPTCHA,
MFA, OTP, WebAuthn, and human-verification challenges stop automation.

### Autonomous and confirmed actions

The model acts only on temporary semantic IDs (for example `e3`) emitted by the
worker's accessible page observer. CSS, XPath, arbitrary JavaScript, and raw DOM
execution are not accepted. Each action returns a fresh observation, allowing
KINO to repeat observe → reason → act → verify up to
`KINO_BROWSER_MAX_STEPS`. Duplicate steps, runtime limits, and missing progress
stop the loop. Final write actions are held as exact pending actions; critical
actions require a generated strong confirmation phrase. The worker revalidates
the page/control and verifies the resulting state before reporting success.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
