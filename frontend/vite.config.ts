import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Запросы /api уходят на бэкенд через прокси: для браузера это тот же адрес, CORS не нужен
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, ".", "");
  const target = env.VITE_API_TARGET;
  if (command === "serve" && !target) throw new Error("Для запуска задайте VITE_API_TARGET текущего API.");
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      // Бэкенд сверяет Origin с DEANERY_ORIGIN, поэтому прокси выдаёт запрос за свой
      proxy: target
        ? {
            "/api": {
              target,
              changeOrigin: true,
              headers: { origin: new URL(target).origin },
            },
          }
        : undefined,
    },
  };
});
