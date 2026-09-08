import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The deployment URL comes from the repo-root .env.local that `npx convex dev`
// writes. Read ONLY that one variable — never expose the rest of the file (it
// also holds CONVEX_DEPLOY_KEY) to the client bundle.
function convexUrl(): string {
  const fromEnv = process.env["VITE_CONVEX_URL"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const env = readFileSync(resolve(here, "../../.env.local"), "utf8");
    const match = env.match(/^CONVEX_URL=(.*)$/m);
    if (match?.[1] !== undefined) return match[1].split(" #")[0]!.trim();
  } catch {
    // fall through to the error below
  }
  throw new Error(
    "No Convex deployment URL. Run `pnpm dev` at the repo root once (writes .env.local) or set VITE_CONVEX_URL.",
  );
}

export default defineConfig({
  plugins: [
    react({ compiler: true }),
  ],
  define: { __CONVEX_URL__: JSON.stringify(convexUrl()) },
});
