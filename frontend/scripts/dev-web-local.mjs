import { spawn } from "node:child_process";

const vitePort = process.env.VITE_DEV_PORT;
if (!vitePort) throw new Error("VITE_DEV_PORT is required");

const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "--port", vitePort, "--strictPort"],
  { stdio: "inherit", env: process.env },
);

vite.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
