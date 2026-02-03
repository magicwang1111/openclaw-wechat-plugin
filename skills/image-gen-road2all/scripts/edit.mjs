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
  const out = { prompt: "", image: "", size: "1024x1024", n: 1, model: "gpt-image-1.5" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prompt" || a === "-p") out.prompt = argv[++i] ?? "";
    else if (a === "--image" || a === "-i") out.image = argv[++i] ?? "";
    else if (a === "--size") out.size = argv[++i] ?? out.size;
    else if (a === "--n" || a === "--count") out.n = Number(argv[++i] ?? "1");
    else if (a === "--model") out.model = argv[++i] ?? out.model;
  }
  if (!out.prompt.trim()) {
    console.error("Missing --prompt");
    process.exit(2);
  }
  if (!out.image.trim()) {
    console.error("Missing --image");
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

  const endpoint = `${baseUrl.replace(/\/$/, "")}/images/edits`;

  const imgBuf = await fs.readFile(args.image);
  const fd = new FormData();
  fd.append("model", args.model);
  fd.append("prompt", args.prompt);
  fd.append("n", String(args.n));
  fd.append("size", args.size);
  fd.append("image", new Blob([imgBuf], { type: "image/png" }), path.basename(args.image));

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: fd,
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
    if (typeof item.b64_json !== "string" || !item.b64_json.trim()) continue;
    const buf = Buffer.from(item.b64_json, "base64");
    const file = path.join(outDir, `road2all-edit-${Date.now()}-${i}.png`);
    await fs.writeFile(file, buf);
    saved.push(file);
  }

  process.stdout.write(JSON.stringify({ ok: true, model: args.model, size: args.size, files: saved }, null, 2));
}

main().catch((err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
