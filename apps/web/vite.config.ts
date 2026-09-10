import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Use the corpus-bearing prod deployment unless the web app gets an explicit override. */
function convexUrl(): string {
  const fromEnv = process.env["VITE_CONVEX_URL"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return "https://sleek-emu-128.convex.cloud";
}

export default defineConfig({
  plugins: [react({ compiler: true })],
  define: { __CONVEX_URL__: JSON.stringify(convexUrl()) },
});
