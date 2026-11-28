import { HttpError, authenticate } from "./access.ts";
import { HOST } from "./config.ts";
import { handleIngress } from "./ingress.ts";
import { handleMcp } from "./mcp.ts";

export { Relay } from "./relay.ts";

function secured(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("Cache-Control", "no-store");
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "no-referrer");
  return result;
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.hostname !== HOST || url.port)
    throw new HttpError(404, "not_found");
  const ingress = /^\/in\/([a-z0-9-]{1,64})$/.exec(url.pathname);
  if (ingress) return handleIngress(request, env, ctx, ingress[1]!);
  if (url.pathname === "/mcp") {
    if (!["POST", "GET", "DELETE"].includes(request.method))
      throw new HttpError(405, "method_not_allowed");
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) throw new HttpError(403, "origin_not_allowed");
    const principal = await authenticate(request, env);
    return handleMcp(request, env, ctx, principal);
  }
  throw new HttpError(404, "not_found");
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return secured(await route(request, env, ctx));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.message : "internal_error";
      return secured(Response.json({ error: { code } }, { status }));
    }
  },
} satisfies ExportedHandler<Env>;
