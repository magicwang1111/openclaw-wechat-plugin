#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

function todayDir() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseArgs(argv) {
  const out = { prompt: "", size: "1024x1024", n: 1, model: "gpt-image-1.5" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt" || a === "-p") out.prompt = argv[++i] ?? "";
    else if (a === "--size") out.size = argv[++i] ?? out.size;
    else if (a === "--n" || a === "--count") out.n = Number(argv[++i] ?? "1");
    else if (a === "--model") out.model = argv[++i] ?? out.model;
  }
  if (!out.prompt.trim()) {
    console.error("Missing --prompt");
    process.exit(2);
  }
  if (!Number.isFinite(out.n) || out.n <= 0) out.n = 1;
  return out;
}

async function loadRoad2allConfig() {
  const envBaseUrl = process.env.ROAD2ALL_BASE_URL?.trim();
  const envKey = process.env.ROAD2ALL_API_KEY?.trim();
  if (envBaseUrl && envKey) return { baseUrl: envBaseUrl, apiKey: envKey };

  const home = process.env.HOME || "";
  const cfgPath = path.join(home, ".clawdbot", "clawdbot.json");
  const raw = await fs.readFile(cfgPath, "utf8");
  const cfg = JSON.parse(raw);
  const road = cfg?.models?.providers?.road2all;
  const baseUrl = (envBaseUrl || road?.baseUrl || "").trim();
  const apiKey = (envKey || road?.apiKey || "").trim();
  if (!baseUrl || !apiKey) {
    throw new Error("Road2all baseUrl/apiKey not found. Set ROAD2ALL_BASE_URL/ROAD2ALL_API_KEY or configure ~/.clawdbot/clawdbot.json models.providers.road2all");
  }
  return { baseUrl, apiKey };
}

async function main() {
  const args = parseArgs(process.argv);
  const { baseUrl, apiKey } = await loadRoad2allConfig();

  const workspace = process.env.CLAWDBOT_WORKSPACE || process.cwd();
  const outDir = path.join(workspace, "downloads", todayDir());
  await fs.mkdir(outDir, { recursive: true });

  const endpoint = `${baseUrl.replace(/\/$/, "")}/images/generations`;
  const body = { model: args.model, prompt: args.prompt, size: args.size, n: args.n };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text}`);
  }

  const json = JSON.parse(text);
  const items = Array.isArray(json?.data) ? json.data : [];
  const saved = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    let buf = null;
    if (typeof item.b64_json === "string" && item.b64_json.trim()) {
      buf = Buffer.from(item.b64_json, "base64");
    } else if (typeof item.url === "string" && item.url.trim()) {
      const r = await fetch(item.url);
      if (!r.ok) throw new Error(`download failed: ${r.status} ${r.statusText}`);
      buf = Buffer.from(new Uint8Array(await r.arrayBuffer()));
    }
    if (!buf) continue;

    const file = path.join(outDir, `road2all-${Date.now()}-${i}.png`);
    await fs.writeFile(file, buf);
    saved.push(file);
  }

  process.stdout.write(JSON.stringify({ ok: true, model: args.model, size: args.size, files: saved }, null, 2));
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
