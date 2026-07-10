import { routeRequest } from './router';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return routeRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
