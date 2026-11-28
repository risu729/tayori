import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      config: "./cloudflare.config.ts",
      remoteBindings: false,
      miniflare: {
        bindings: {
          // Synthetic values only: 32 zero bytes, targets under .invalid, and a
          // synthetic routine id and key for the pinned claude-routine host.
          SOURCE_FUMI_SECRET: `whsec_${btoa(String.fromCharCode(...new Uint8Array(32)))}`,
          TARGET_GROK_A_INBOX: JSON.stringify({
            url: "https://grok-a.example.invalid/automations/webhook/synthetic-a",
            key: "synthetic-key-a",
          }),
          TARGET_GROK_B_INBOX: JSON.stringify({
            url: "https://grok-b.example.invalid/automations/webhook/synthetic-b",
            key: "synthetic-key-b",
          }),
          TARGET_GROK_A_DESK: JSON.stringify({
            url: "https://grok-a.example.invalid/automations/webhook/synthetic-a-desk",
            key: "synthetic-key-a-desk",
          }),
          TARGET_GROK_B_DESK: JSON.stringify({
            url: "https://grok-b.example.invalid/automations/webhook/synthetic-b-desk",
            key: "synthetic-key-b-desk",
          }),
          // The claude-routine pin requires this host; tests mock every fetch.
          TARGET_CLAUDE: JSON.stringify({
            url: "https://api.anthropic.com/v1/claude_code/routines/trig_synthetic0/fire",
            key: "synthetic-key-claude",
          }),
          ACCESS_ISSUER: "https://synthetic.cloudflareaccess.com",
          ACCESS_AUDIENCE: "synthetic-app",
          ALLOWED_PRINCIPALS: JSON.stringify(["user:synthetic-owner"]),
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
