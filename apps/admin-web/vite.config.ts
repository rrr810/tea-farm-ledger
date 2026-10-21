import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: "/admin/", // admin is served under /admin on the API's static host — assets must resolve there too
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5174,
    allowedHosts: true,
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true }, "/health": { target: "http://localhost:3000", changeOrigin: true } },
  },
  preview: { host: "0.0.0.0", port: 4174, allowedHosts: true },
  build: { outDir: "dist" },
});
