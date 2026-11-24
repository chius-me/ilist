import { deleteAuthRateLimitsBefore } from './db/rate-limits';
import { deleteExpiredOAuthStates } from './oauth-core';
import { routeRequest } from './router';
import { cleanupExpiredSessions } from './routes/auth';
import type { Env } from './types';
import { cleanupExpiredUploads } from './upload-service';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return routeRequest(request, env, {}, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const rateLimitCutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    ctx.waitUntil(
      Promise.allSettled([
        cleanupExpiredUploads(env),
        cleanupExpiredSessions(env),
        deleteExpiredOAuthStates(env.DB),
        deleteAuthRateLimitsBefore(env.DB, rateLimitCutoff, 100),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
