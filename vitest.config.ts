import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      config: "./cloudflare.config.ts",
      remoteBindings: false,
      miniflare: {
        bindings: {
          // Synthetic values only: 32 zero bytes, and targets under .invalid.
          SOURCE_FUMI_SECRET: `whsec_${btoa(String.fromCharCode(...new Uint8Array(32)))}`,
          TARGET_GROK_A: JSON.stringify({
            url: "https://grok-a.example.invalid/automations/webhook/synthetic-a",
            key: "synthetic-key-a",
          }),
          TARGET_GROK_B: JSON.stringify({
            url: "https://grok-b.example.invalid/automations/webhook/synthetic-b",
            key: "synthetic-key-b",
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
