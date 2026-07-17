import { z } from 'zod';

/**
 * `GET /version` payload (issue #179).
 *
 * Dedicated version endpoint separate from `/health` so:
 *  - monitors can check version drift without pulling AI-config state,
 *  - both surfaces (web TopBar chip, CLI `regard dashboard` connect line)
 *    render a stable "srv X.Y.Z · core X.Y.Z" string from the same schema,
 *  - the eventual dynamic-auth-token handshake (#18) has a clean, minimal
 *    target that never leaks config.
 *
 * `api` is a small integer we bump on breaking wire changes so a stale CLI
 * can warn when it's talking to an incompatible server (or vice versa).
 * `startedAt` is the ISO timestamp of process start — useful for spotting
 * silent restarts from either surface.
 */
export const ServerVersion = z.object({
  server: z.string().min(1),
  core: z.string().min(1),
  node: z.string().min(1),
  api: z.number().int().nonnegative(),
  startedAt: z.string().min(1),
});
export type ServerVersion = z.infer<typeof ServerVersion>;

/**
 * Current wire-format API version. Bump only on breaking changes to any
 * server response shape or endpoint contract that both surfaces rely on.
 */
export const SERVER_API_VERSION = 1;
