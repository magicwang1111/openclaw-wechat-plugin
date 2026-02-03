import { registerPluginHttpRoute, type ChannelGatewayContext } from "openclaw/plugin-sdk";
import type { IncomingMessage } from "node:http";
import { getSimpleWecomRuntime } from "./runtime.js";
import { simpleWecomClient, type SimpleWecomMessage } from "./client.js";
import { road2allGenerateImage, road2allEditImage } from "./road2all-image.js";
import { parseMultipart } from "./multipart.js";
import fs from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { verifySignature, decryptMessage, calculateSignature } from "./crypto.js";
import { parseWeComMessage, formatMessageForopenclaw } from "./message-parser.js";
import { XMLParser } from "fast-xml-parser";
import { inspect } from "node:util";
import path from "node:path";
import { wecomOfficialAPI } from "./official-api.js";
import { TTLSeenSet, makeDedupeKey } from "./dedupe.js";

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const uploadDedupe = new TTLSeenSet(10 * 60 * 1000);

function todayDir() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function resolveWorkspace() {
  return process.env.CLAWDBOT_WORKSPACE || process.env.OPENCLAW_WORKSPACE || "/data1/wangxi/clawdbot";
}

function extFromContentType(ct?: string) {
  const t = (ct || "").split(";")[0].trim().toLowerCase();
  if (t === "image/png") return ".png";
  if (t === "image/jpeg") return ".jpg";
  if (t === "image/jpg") return ".jpg";
  if (t === "image/webp") return ".webp";
  return ".bin";
}

type ReplyDispatchArgs = {
  ctx: {
    From: string;
    Body: string;
    AccountId: string;
    SessionKey: string;
    MediaUrls?: string[];
    GroupSystemPrompt?: string;
  };
  cfg: any;
  dispatcherOptions: {
    responsePrefix?: string;
    deliver: (payload: { text?: string; mediaUrl?: string }) => Promise<void>;
    onError?: (err: any) => void;
  };
  replyOptions?: any;
};

async function dispatchReplyFromConfig(args: ReplyDispatchArgs) {
  // 这里不去 import openclaw 内部的 auto-reply（它没有 exports）。
  // 直接走 runtime 暴露的 channel.reply 派发器。
  const runtime = getSimpleWecomRuntime();
  const reply = (runtime as any)?.channel?.reply;

  const dispatcher =
    reply?.dispatchReplyWithBufferedBlockDispatcher ??
    reply?.dispatchReplyFromConfig;

  if (typeof dispatcher !== "function") {
    throw new Error(
      "SimpleWeCom: runtime.channel.reply dispatcher not available (expected dispatchReplyWithBufferedBlockDispatcher/dispatchReplyFromConfig)"
    );
  }

  return await dispatcher({
    ctx: args.ctx,
    cfg: args.cfg,
    dispatcherOptions: args.dispatcherOptions,
    replyOptions: args.replyOptions,
  });
}


export function startSimpleWecomAccount(ctx: ChannelGatewayContext) {
  const accountId = ctx.account.accountId;
  const config = ctx.account.config as any;

  const unregisterMessage = registerPluginHttpRoute({
    pluginId: "simple-wecom",
    accountId,
    path: "/simple-wecom/message",
    handler: async (req, res) => {
      const url = new URL(req.url || "", `http://${req.headers.host}`);

      // ===== GET：URL 验证 =====
      if (req.method === "GET") {
        const msgSignature = url.searchParams.get("msg_signature");
        const timestamp = url.searchParams.get("timestamp");
        const nonce = url.searchParams.get("nonce");
        const echostr = url.searchParams.get("echostr");

        const token = config.token;
        if (!token) {
          res.statusCode = 500;
          res.end("Token not configured");
          return;
        }

        if (!msgSignature || !timestamp || !nonce || !echostr) {
          res.statusCode = 400;
          res.end("Missing required parameters");
          return;
        }

        try {
          const expectedSignature = calculateSignature(token, timestamp, nonce, echostr);
          if (expectedSignature !== msgSignature) {
            res.statusCode = 403;
            res.end("Invalid signature");
            return;
          }

          const encodingAESKey = config.encodingAESKey;
          const corpid = config.corpid;
          if (!encodingAESKey || !corpid) {
            res.statusCode = 500;
            res.end("encodingAESKey or corpid not configured");
            return;
          }

          const decryptedEchoStr = decryptMessage(encodingAESKey, echostr, corpid);
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain");
          res.end(decryptedEchoStr);
        } catch (error) {
          console.error("WeChat verification failed:", error);
          res.statusCode = 500;
          res.end(String(error));
        }
        return;
      }

      // ===== POST：接收消息 =====
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }

      try {
        const contentType = req.headers["content-type"] || "";

        const isEncryptedWeComMessage =
          contentType.includes("text/xml") ||
          contentType.includes("application/xml") ||
          url.searchParams.has("msg_signature");

        if (isEncryptedWeComMessage) {
          await handleEncryptedWeComMessage(req, res, url, ctx, accountId);
        } else {
          await handleLegacyMessage(req, res, contentType, ctx, accountId);
        }
      } catch (e) {
        console.error("SimpleWeCom handler error:", e);
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end(String(e));
        }
      }
    },
  });

  const unregisterPoll = registerPluginHttpRoute({
    pluginId: "simple-wecom",
    accountId,
    path: "/simple-wecom/messages",
    handler: async (req, res) => {
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }

      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const email = url.searchParams.get("email");

      if (!email) {
        res.statusCode = 400;
        res.end("Missing email param");
        return;
      }

      const messages = simpleWecomClient.getPendingMessages(email);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ messages }));
    },
  });

  return {
    stop: () => {
      unregisterMessage();
      unregisterPoll();
    },
  };
}

/**
 * 处理企业微信加密消息
 */
async function handleEncryptedWeComMessage(
  req: IncomingMessage,
  res: any,
  url: URL,
  ctx: ChannelGatewayContext,
  accountId: string
) {
  // (debug) 如需排查 runtime/dispatcher 挂载点再打开这些日志

  const config = ctx.account.config as any;

  const msgSignature = url.searchParams.get("msg_signature");
  const timestamp = url.searchParams.get("timestamp");
  const nonce = url.searchParams.get("nonce");

  const token = config.token;
  const encodingAESKey = config.encodingAESKey;
  const corpid = config.corpid;

  if (!token || !encodingAESKey || !corpid) {
    res.statusCode = 500;
    res.end("Token, encodingAESKey or corpid not configured");
    return;
  }

  if (!msgSignature || !timestamp || !nonce) {
    res.statusCode = 400;
    res.end("Missing signature parameters");
    return;
  }

  // 读 XML
  const rawBody = await readBody(req);
  const xmlString = rawBody.toString("utf8");

  console.log("=== Received WeCom Encrypted Message ===");
  console.log("XML:", xmlString);

  // 解析 Encrypt
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
  });

  const xmlObj = parser.parse(xmlString);
  const encryptedMsg = xmlObj.xml?.Encrypt || xmlObj.xml?.encrypt;

  if (!encryptedMsg) {
    res.statusCode = 400;
    res.end("Missing Encrypt field in XML");
    return;
  }

  // 验签
  const isValid = verifySignature(token, timestamp, nonce, encryptedMsg, msgSignature);
  if (!isValid) {
    console.error("Invalid message signature");
    res.statusCode = 403;
    res.end("Invalid signature");
    return;
  }

  // 解密
  let decryptedXml: string;
  try {
    decryptedXml = decryptMessage(encodingAESKey, encryptedMsg, corpid);
    console.log("=== Decrypted Message XML ===");
    console.log(decryptedXml);
  } catch (error) {
    console.error("Decryption failed:", error);
    res.statusCode = 500;
    res.end("Decryption failed");
    return;
  }

  // 解析企业微信消息
  let wecomMessage: any;
  try {
    wecomMessage = parseWeComMessage(decryptedXml);
  } catch (e) {
    // 解析炸了也别让企业微信一直重试把你打爆；至少先 success
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("success");
    console.error("[simple-wecom] parseWeComMessage failed:", e);
    return;
  }

  console.log("=== Parsed WeCom Message ===");
  console.log(JSON.stringify(wecomMessage, null, 2));

  // ✅ event：直接吞掉，别进 agent，别抛错
  const msgType = String(wecomMessage?.MsgType ?? "").toLowerCase();
  if (msgType === "event") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("success");

    ctx.log?.info?.("[simple-wecom] ignore event message", JSON.stringify({
      FromUserName: wecomMessage?.FromUserName,
      Event: wecomMessage?.Event,
      EventKey: wecomMessage?.EventKey
    }));

    return;
  }

  // 图片消息：下载落盘 + 引导用户编辑
  if (msgType === "image") {
    const mediaId = String(wecomMessage?.MediaId || "").trim();
    const fromUser = String(wecomMessage?.FromUserName || "").trim();

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("success");

    if (!mediaId || !fromUser) {
      ctx.log?.warn?.("[simple-wecom] image message missing MediaId/FromUserName");
      return;
    }

    const key = makeDedupeKey(["simple-wecom", accountId, fromUser, mediaId]);
    if (uploadDedupe.seen(key)) {
      ctx.log?.info?.("[simple-wecom] skip duplicate image", key);
      return;
    }

    try {
      const config = ctx.account.config as any;
      if (!config.corpid || !config.corpsecret) {
        await simpleWecomClient.sendMessage(fromUser, { text: "收到图片了，但未配置 corpid/corpsecret，无法下载图片。" }, {
          webhookUrl: config.webhookUrl,
          webhookToken: config.webhookToken,
          weworkApiUrl: config.weworkApiUrl,
          weworkNamespace: config.weworkNamespace,
          weworkToken: config.weworkToken,
          weworkCode: config.weworkCode,
          corpid: config.corpid,
          corpsecret: config.corpsecret,
          agentid: config.agentid,
          token: config.token,
          encodingAESKey: config.encodingAESKey,
        });
        return;
      }

      const dl = await wecomOfficialAPI.downloadMedia(config.corpid, config.corpsecret, mediaId);
      const ext = extFromContentType(dl.contentType);
      const workspace = resolveWorkspace();
      const outDir = path.join(workspace, "uploads", todayDir());
      await fs.mkdir(outDir, { recursive: true });
      const outPath = path.join(outDir, `wecom-${Date.now()}-${mediaId}${ext}`);
      await fs.writeFile(outPath, dl.data);

      await simpleWecomClient.sendMessage(fromUser, { text: `已收到图片并保存：${outPath}\n想怎么改？（你也可以用：IMAGE_EDIT: ${outPath} | <你的修改要求>）` }, {
        webhookUrl: config.webhookUrl,
        webhookToken: config.webhookToken,
        weworkApiUrl: config.weworkApiUrl,
        weworkNamespace: config.weworkNamespace,
        weworkToken: config.weworkToken,
        weworkCode: config.weworkCode,
        corpid: config.corpid,
        corpsecret: config.corpsecret,
        agentid: config.agentid,
        token: config.token,
        encodingAESKey: config.encodingAESKey,
      });
    } catch (e) {
      console.error("[simple-wecom] image download/save failed:", e);
      ctx.log?.error?.("[simple-wecom] image download/save failed", String(e));
    }

    return;
  }

  // 转 openclaw 格式
  const { text, mediaUrls } = formatMessageForopenclaw(wecomMessage);
  const userId = wecomMessage.FromUserName;

  console.log("=== Simple WeCom Context to Agent ===");
  console.log("From:", userId);
  console.log("Body:", text);
  console.log("MediaUrls:", mediaUrls);
  console.log("===================================");

  // 先 success（企业微信 5s 要求）
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain");
  res.end("success");

  // 异步 dispatch
  const systemPrompt = config.systemPrompt?.trim() || undefined;

  // Dispatch via OpenClaw core

  const args: ReplyDispatchArgs = {
    ctx: {
      From: userId,
      Body: text,
      AccountId: accountId,
      SessionKey: `simple-wecom:${accountId}:${userId}`,
      MediaUrls: mediaUrls,
      GroupSystemPrompt: systemPrompt,
    },
    cfg: (ctx as any).cfg, // cfg 仍然用全局 cfg（models/gateway/plugins...）
    dispatcherOptions: {
      responsePrefix: "",
      deliver: async (payload) => {
        console.log("=== Simple WeCom Deliver Payload ===");
        console.log("Text:", payload.text);
        console.log("MediaUrl:", payload.mediaUrl);
        console.log("================================");

        const rawText = String(payload.text || "").trim();

        // 指令驱动：IMAGE_GEN / IMAGE_EDIT
        if (rawText.startsWith("IMAGE_GEN:")) {
          const prompt = rawText.slice("IMAGE_GEN:".length).trim();
          const baseUrl = String(
            process.env.ROAD2ALL_BASE_URL ||
            (config.road2allBaseUrl ?? (ctx as any)?.cfg?.models?.providers?.road2all?.baseUrl ?? "")
          ).trim();
          const apiKey = String(
            process.env.ROAD2ALL_API_KEY ||
            (config.road2allApiKey ?? (ctx as any)?.cfg?.models?.providers?.road2all?.apiKey ?? "")
          ).trim();
          if (!baseUrl || !apiKey) {
            await simpleWecomClient.sendMessage(
              userId,
              { text: "未配置 Road2all（缺少 ROAD2ALL_BASE_URL/ROAD2ALL_API_KEY）" },
              {
                webhookUrl: config.webhookUrl,
                webhookToken: config.webhookToken,
                weworkApiUrl: config.weworkApiUrl,
                weworkNamespace: config.weworkNamespace,
                weworkToken: config.weworkToken,
                weworkCode: config.weworkCode,
                corpid: config.corpid,
                corpsecret: config.corpsecret,
                agentid: config.agentid,
                token: config.token,
                encodingAESKey: config.encodingAESKey,
              }
            );
            return;
          }
          const { filePath } = await road2allGenerateImage({
            baseUrl,
            apiKey,
            prompt,
            model: config.road2allModel || "gpt-image-1.5",
            size: config.road2allSize || "1024x1024",
          });
          await simpleWecomClient.sendMessage(userId, { imagePath: filePath }, {
            webhookUrl: config.webhookUrl,
            webhookToken: config.webhookToken,
            weworkApiUrl: config.weworkApiUrl,
            weworkNamespace: config.weworkNamespace,
            weworkToken: config.weworkToken,
            weworkCode: config.weworkCode,
            corpid: config.corpid,
            corpsecret: config.corpsecret,
            agentid: config.agentid,
            token: config.token,
            encodingAESKey: config.encodingAESKey,
          });
          return;
        }

        if (rawText.startsWith("IMAGE_EDIT:")) {
          // 格式：IMAGE_EDIT: <imagePath> | <prompt>
          const rest = rawText.slice("IMAGE_EDIT:".length).trim();
          const parts = rest.split("|").map((s) => s.trim()).filter(Boolean);
          const imagePath = parts[0];
          const prompt = parts.slice(1).join(" | ");

          const baseUrl = String(
            process.env.ROAD2ALL_BASE_URL ||
            (config.road2allBaseUrl ?? (ctx as any)?.cfg?.models?.providers?.road2all?.baseUrl ?? "")
          ).trim();
          const apiKey = String(
            process.env.ROAD2ALL_API_KEY ||
            (config.road2allApiKey ?? (ctx as any)?.cfg?.models?.providers?.road2all?.apiKey ?? "")
          ).trim();
          if (!baseUrl || !apiKey) {
            await simpleWecomClient.sendMessage(
              userId,
              { text: "未配置 Road2all（缺少 ROAD2ALL_BASE_URL/ROAD2ALL_API_KEY）" },
              {
                webhookUrl: config.webhookUrl,
                webhookToken: config.webhookToken,
                weworkApiUrl: config.weworkApiUrl,
                weworkNamespace: config.weworkNamespace,
                weworkToken: config.weworkToken,
                weworkCode: config.weworkCode,
                corpid: config.corpid,
                corpsecret: config.corpsecret,
                agentid: config.agentid,
                token: config.token,
                encodingAESKey: config.encodingAESKey,
              }
            );
            return;
          }
          if (!imagePath || !prompt) {
            await simpleWecomClient.sendMessage(userId, { text: "IMAGE_EDIT 格式错误，应为：IMAGE_EDIT: <imagePath> | <prompt>" }, {
              webhookUrl: config.webhookUrl,
              webhookToken: config.webhookToken,
              weworkApiUrl: config.weworkApiUrl,
              weworkNamespace: config.weworkNamespace,
              weworkToken: config.weworkToken,
              weworkCode: config.weworkCode,
              corpid: config.corpid,
              corpsecret: config.corpsecret,
              agentid: config.agentid,
              token: config.token,
              encodingAESKey: config.encodingAESKey,
            });
            return;
          }

          const { filePath } = await road2allEditImage({
            baseUrl,
            apiKey,
            imagePath,
            prompt,
            model: config.road2allModel || "gpt-image-1.5",
            size: config.road2allSize || "1024x1024",
          });
          await simpleWecomClient.sendMessage(userId, { imagePath: filePath }, {
            webhookUrl: config.webhookUrl,
            webhookToken: config.webhookToken,
            weworkApiUrl: config.weworkApiUrl,
            weworkNamespace: config.weworkNamespace,
            weworkToken: config.weworkToken,
            weworkCode: config.weworkCode,
            corpid: config.corpid,
            corpsecret: config.corpsecret,
            agentid: config.agentid,
            token: config.token,
            encodingAESKey: config.encodingAESKey,
          });
          return;
        }

        const msg: SimpleWecomMessage = {
          text: payload.text,
          mediaUrl: payload.mediaUrl,
        };

        await simpleWecomClient.sendMessage(userId, msg, {
          webhookUrl: config.webhookUrl,
          webhookToken: config.webhookToken,
          weworkApiUrl: config.weworkApiUrl,
          weworkNamespace: config.weworkNamespace,
          weworkToken: config.weworkToken,
          weworkCode: config.weworkCode,
          corpid: config.corpid,
          corpsecret: config.corpsecret,
          agentid: config.agentid,
          token: config.token,
          encodingAESKey: config.encodingAESKey,
          road2allBaseUrl: (config as any).road2allBaseUrl,
          road2allApiKey: (config as any).road2allApiKey,
          road2allModel: (config as any).road2allModel,
          road2allSize: (config as any).road2allSize,
        } as any);
      },
      onError: (err) => {
        console.error("SimpleWeCom dispatch error:", err);
      },
    },
    replyOptions: {},
  };

  // 不 await：请求已结束，别阻塞 handler
  void dispatchReplyFromConfig(args).catch((e) => {
    console.error("[simple-wecom] dispatch crashed:", e);
    ctx.log?.error?.("[simple-wecom] dispatch crashed", String(e));
  });
}

/**
 * 处理原有的 JSON/Multipart 格式消息（向后兼容）
 */
async function handleLegacyMessage(
  req: IncomingMessage,
  res: any,
  contentType: string,
  ctx: ChannelGatewayContext,
  accountId: string
) {
  let email: string | undefined;
  let text: string | undefined;
  let imageUrl: string | undefined;
  let sync = false;
  const files: Array<{ filename: string; path: string; mimetype: string }> = [];

  if (contentType.includes("application/json")) {
    const raw = await readBody(req);
    if (raw.length === 0) {
      res.statusCode = 400;
      res.end("Empty body");
      return;
    }
    const body = JSON.parse(raw.toString());
    email = body.email;
    text = body.text;
    imageUrl = body.imageUrl;
    sync = Boolean(body.sync);
  } else if (contentType.includes("multipart/form-data")) {
    const boundary = contentType.split("boundary=")[1]?.split(";")[0];
    if (!boundary) throw new Error("No boundary");
    const buffer = await readBody(req);
    const result = parseMultipart(buffer, boundary);

    email = result.fields.email;
    text = result.fields.text;
    sync = result.fields.sync === "true";

    for (const file of result.files) {
      const tempPath = join(tmpdir(), `simple-wecom-${randomUUID()}-${file.filename}`);
      await writeFile(tempPath, file.data);
      files.push({
        filename: file.filename,
        path: tempPath,
        mimetype: file.mimetype,
      });
    }
  }

  if (!email) {
    res.statusCode = 400;
    res.end("Missing email");
    return;
  }

  if (sync) {
    simpleWecomClient.registerPendingRequest(email, res);
  } else {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
  }

  const mediaUrls: string[] = [];
  if (imageUrl) mediaUrls.push(imageUrl);
  for (const file of files) mediaUrls.push(`file://${file.path}`);

  let enrichedText = text || "";
  if (files.length > 0) {
    enrichedText += "\n\n[上传的文件]";
    for (const file of files) {
      enrichedText += `\n- ${file.filename}: ${file.path}`;
    }
  }

  console.log("=== Simple WeCom Context to Agent ===");
  console.log("From:", email);
  console.log("Body:", enrichedText);
  console.log("MediaUrls:", mediaUrls);
  console.log("Files count:", files.length);
  console.log("===================================");

  const config = ctx.account.config as any;
  const systemPrompt = config.systemPrompt?.trim() || undefined;

  // Dispatch via OpenClaw core

  const args: ReplyDispatchArgs = {
    ctx: {
      From: email,
      Body: enrichedText,
      AccountId: accountId,
      SessionKey: `simple-wecom:${accountId}:${email}`,
      MediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      GroupSystemPrompt: systemPrompt,
    },
    cfg: (ctx as any).cfg,
    dispatcherOptions: {
      responsePrefix: "",
      deliver: async (payload) => {
        console.log("=== Simple WeCom Deliver Payload ===");
        console.log("Text:", payload.text);
        console.log("MediaUrl:", payload.mediaUrl);
        console.log("================================");

        const msg: SimpleWecomMessage = {
          text: payload.text,
          mediaUrl: payload.mediaUrl,
        };

        await simpleWecomClient.sendMessage(email!, msg, {
          webhookUrl: config.webhookUrl,
          webhookToken: config.webhookToken,
          weworkApiUrl: config.weworkApiUrl,
          weworkNamespace: config.weworkNamespace,
          weworkToken: config.weworkToken,
          weworkCode: config.weworkCode,
          corpid: config.corpid,
          corpsecret: config.corpsecret,
          agentid: config.agentid,
          token: config.token,
          encodingAESKey: config.encodingAESKey,
        });
      },
      onError: (err) => {
        console.error("SimpleWeCom dispatch error:", err);
      },
    },
    replyOptions: {},
  };

  // legacy 这里也别 await：同步/异步两种场景都更稳
  void dispatchReplyFromConfig(args).catch((e) => {
    console.error("[simple-wecom] legacy dispatch crashed:", e);
    ctx.log?.error?.("[simple-wecom] legacy dispatch crashed", String(e));
  });
}
