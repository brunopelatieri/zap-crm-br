import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Segredos fictícios — encryption.ts / webhook-signature.ts leem estes
    // valores no carregamento do módulo. Os testes nunca chamam um serviço
    // real da Meta/Supabase, então qualquer hex de 32 bytes / string não
    // vazia serve; mantenha-os lexicamente idênticos ao ambiente de build
    // do CI para que o comportamento seja o mesmo.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
    clearMocks: true,
  },
});
