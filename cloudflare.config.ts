import { defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { compatibilityDate } from "./worker-runtime.ts";

export default defineConfig({
  worker: {
    name: "tayori",
    entrypoint,
    compatibilityDate,
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
