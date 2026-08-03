# Dashboard session security

RegardedTrader is local-only, but localhost is still a shared boundary: other
local apps and browser tabs can reach `127.0.0.1` unless we gate access.

## Threat model

- **Trusted:** the user who runs `regard dashboard`.
- **Untrusted:** other local processes, browser tabs, extensions, and scripts
  on the same machine.
- **Goal:** only the session launched by the CLI can call non-health API routes.

## Controls

1. Server still binds to `127.0.0.1`/`localhost` only.
2. `regard dashboard` mints a high-entropy per-launch token and injects it into
   the dashboard URL once (`?t=...`).
3. The SPA moves the token into `sessionStorage` (`rt.auth`) and immediately
   removes it from the address bar (`history.replaceState`).
4. API requests use `Authorization: Bearer <token>`.
5. Server uses constant-time comparison (`timingSafeEqual`) and rejects
   non-authenticated requests with `401` (except `GET /health`).
6. Failed auth attempts are rate-limited and logged.
7. CORS is narrowed to the exact dashboard origin for that launch.

## Token lifetime and rotation

- Token lives only for the active dashboard process.
- Ctrl-C / process exit revokes the session by terminating child processes.
- Re-running `regard dashboard` mints a new token and invalidates prior access.
- Token is never persisted to disk, cookies, or localStorage.

## If a token leaks

Stop the dashboard (`Ctrl-C`) and run `regard dashboard` again. The prior token
dies with the previous session.

## Contributor mode

`npm run dev` / `npm run dev:server` pass `--allow-no-auth` for local
development workflows. This mode is intentionally unauthenticated and logs a
security banner; do not use it as the production launcher.
