// server/index.js — LOCAL dev/standalone server.
// Builds the shared Express app, serves the built client, and listens.
// (On Vercel the app is exported from api/index.js instead; static hosting
// there is handled by vercel.json.)
import "dotenv/config";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

const app = createApp();

// serve the built client in production/standalone
const clientDist = path.join(__dirname, "..", "client", "dist");
if (existsSync(clientDist)) {
  const express = (await import("express")).default;
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`\n  Stylish Care App → http://localhost:${PORT}\n`);
});
