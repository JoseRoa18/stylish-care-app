// api/index.js — Vercel serverless entry.
// Vercel routes every /api/* request here (see vercel.json). The exported
// Express app handles the routing; env vars come from the Vercel project.
import "dotenv/config";
import { createApp } from "../server/app.js";

export default createApp();
