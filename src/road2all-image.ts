import fs from "node:fs/promises";
import path from "node:path";

function todayDir() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resolveWorkspace() {
  // 默认走 OpenClaw 配置里的 workspace；确保落盘到 /data1/wangxi/clawdbot
  return process.env.CLAWDBOT_WORKSPACE || process.env.OPENCLAW_WORKSPACE || "/data1/wangxi/clawdbot";
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeSize(size?: string) {
  // Road2all/OpenAI Images 常见枚举；避免传 1536x864 这种非法值。
  const allowed = new Set(["1024x1024", "1024x1536", "1536x1024"]);
  const s = (size || "").trim();
  if (allowed.has(s)) return s;
  return "1024x1024";
}

export async function road2allGenerateImage(params: {
  baseUrl: string;
  apiKey: string;
  prompt: string;
  model?: string;
  size?: string;
}): Promise<{ filePath: string }>
{
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const apiKey = params.apiKey;
  const endpoint = `${baseUrl}/images/generations`;

  const body = {
    model: params.model || "gpt-image-1.5",
    prompt: params.prompt,
    size: normalizeSize(params.size),
    n: 1,
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`road2all generations HTTP ${resp.status}: ${text}`);

  const json = JSON.parse(text);
  const item = Array.isArray(json?.data) ? json.data[0] : undefined;
  if (!item) throw new Error(`road2all generations invalid response: ${text}`);

  let buf: Buffer | null = null;
  if (typeof item.b64_json === "string" && item.b64_json.trim()) {
    buf = Buffer.from(item.b64_json, "base64");
  } else if (typeof item.url === "string" && item.url.trim()) {
    const r = await fetch(item.url);
    if (!r.ok) throw new Error(`road2all generations download failed: ${r.status} ${r.statusText}`);
    buf = Buffer.from(new Uint8Array(await r.arrayBuffer()));
  }
  if (!buf) throw new Error(`road2all generations missing image data: ${text}`);

  const workspace = resolveWorkspace();
  const outDir = path.join(workspace, "downloads", todayDir());
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `road2all-${Date.now()}.png`);
  await fs.writeFile(filePath, buf);
  return { filePath };
}

export async function road2allEditImage(params: {
  baseUrl: string;
  apiKey: string;
  imagePath: string;
  prompt: string;
  model?: string;
  size?: string;
}): Promise<{ filePath: string }>
{
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const apiKey = params.apiKey;
  const endpoint = `${baseUrl}/images/edits`;

  const buf = await fs.readFile(params.imagePath);
  const filename = path.basename(params.imagePath);

  const form = new FormData();
  form.append("model", params.model || "gpt-image-1.5");
  form.append("prompt", params.prompt);
  form.append("size", normalizeSize(params.size));
  form.append("n", "1");
  form.append("image", new Blob([buf]), filename);

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`road2all edits HTTP ${resp.status}: ${text}`);

  const json = JSON.parse(text);
  const item = Array.isArray(json?.data) ? json.data[0] : undefined;
  if (!item) throw new Error(`road2all edits invalid response: ${text}`);

  let out: Buffer | null = null;
  if (typeof item.b64_json === "string" && item.b64_json.trim()) {
    out = Buffer.from(item.b64_json, "base64");
  } else if (typeof item.url === "string" && item.url.trim()) {
    const r = await fetch(item.url);
    if (!r.ok) throw new Error(`road2all edits download failed: ${r.status} ${r.statusText}`);
    out = Buffer.from(new Uint8Array(await r.arrayBuffer()));
  }
  if (!out) throw new Error(`road2all edits missing image data: ${text}`);

  const workspace = resolveWorkspace();
  const outDir = path.join(workspace, "downloads", todayDir());
  await fs.mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `road2all-edit-${Date.now()}.png`);
  await fs.writeFile(filePath, out);
  return { filePath };
}
