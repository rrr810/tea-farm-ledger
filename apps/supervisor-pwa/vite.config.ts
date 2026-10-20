import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    hmr: { clientPort: 443 },
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true }, "/health": { target: "http://localhost:3000", changeOrigin: true } }
  },
  preview: { host: "0.0.0.0", port: 4173, allowedHosts: true },
});
