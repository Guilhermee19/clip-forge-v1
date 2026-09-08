import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * O proxy evita CORS e deixa o frontend usar caminhos relativos (`/api/...`),
 * o mesmo que funcionaria se o build fosse servido pelo proprio FastAPI.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/media": { target: "http://127.0.0.1:8000", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
});
