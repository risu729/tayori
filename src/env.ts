// Secrets are optional at deploy: the relay fails closed (503) until the owner
// sets them, so a deploy never depends on a credential being present.
declare global {
  namespace Cloudflare {
    interface Env {
      SOURCE_FUMI_SECRET?: string;
      TARGET_GROK_A_INBOX?: string;
      TARGET_GROK_B_INBOX?: string;
      TARGET_GROK_A_DESK?: string;
      TARGET_GROK_B_DESK?: string;
      TARGET_CLAUDE?: string;
      ACCESS_ISSUER?: string;
      ACCESS_AUDIENCE?: string;
      /** JSON array of Access principals allowed to call MCP, such as `["user:<sub>"]`. */
      ALLOWED_PRINCIPALS?: string;
    }
  }
}
export {};
