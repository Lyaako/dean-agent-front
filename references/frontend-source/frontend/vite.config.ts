import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Запросы /api уходят на бэкенд через прокси: для браузера это тот же адрес, CORS не нужен
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { "/api": { target: env.VITE_API_TARGET || "http://localhost:8010", changeOrigin: true } },
    },
  };
});
