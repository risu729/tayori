import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { compatibilityDate } from "./worker-runtime.ts";

export default defineConfig({
  worker: {
    name: "tayori",
    entrypoint,
    compatibilityDate,
    domains: ["tayori.takuk.me", "tayori-mcp.takuk.me"],
    exports: {
      Relay: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      RELAY: bindings.durableObject({ worker: "tayori", exportName: "Relay" }),
    },
    // Set explicitly: without routes or domains, cf enables workers.dev at deploy
    // (getSubdomainValues). Only the Custom Domains in docs/design.md may serve.
    workersDev: false,
    // Set explicitly: for an unset value cf sends no preview setting at deploy
    // (getSubdomainValues) and leaves it to the API.
    previewUrls: false,
    observability: {
      enabled: true,
      // Set explicitly: cf omits an unset rate, and its default is set by the API.
      headSamplingRate: 1,
    },
  },
});
