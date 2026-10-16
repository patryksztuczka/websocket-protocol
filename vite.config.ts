import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 80,
    ignorePatterns: ["pnpm-lock.yaml", "test/autobahn/reports/**"],
  },
  lint: {
    ignorePatterns: ["test/autobahn/reports/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
