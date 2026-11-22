// The relay is not built yet: every request gets 404 until the request path
// in docs/design.md lands.
export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
