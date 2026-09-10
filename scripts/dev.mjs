import { spawn } from "node:child_process";

// Start both children without shell-specific backgrounding; stop siblings on exit.
const children = [
  spawn("pnpm", ["exec", "convex", "dev"], { stdio: "inherit" }),
  spawn("pnpm", ["web"], { stdio: "inherit" }),
];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
}
for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
