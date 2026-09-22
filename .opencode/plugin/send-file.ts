import { type Plugin, tool } from "@opencode-ai/plugin";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { File, FormData, ProxyAgent, fetch as undiciFetch } from "undici";

const z = tool.schema;

const GMAIL_DELIVERY_URL =
  process.env.GMAIL_DELIVERY_URL?.trim() ||
  `http://127.0.0.1:${Number(process.env.GMAIL_DELIVERY_PORT) || 4098}/gmail/send-file`;

const DEFAULT_TELEGRAM_ENV_FILE = path.resolve(
  process.cwd(),
  "../opencode-telegram-bot/.env",
);
const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

interface TelegramConfig {
  token: string;
  chatId: string;
  apiRoot: string;
  proxyUrl: string;
  proxySecret: string;
}

type DeliveryOutcome =
  // The channel accepted and delivered/queued the file.
  | { kind: "delivered" }
  // The endpoint answered 404 — this session isn't owned by that channel.
  | { kind: "not_owned" }
  // The endpoint was unreachable (bot/bridge not running on this host).
  | { kind: "unreachable" }
  // The channel owns the session but rejected the file (e.g. bad path, too big).
  | { kind: "rejected"; error: string };

async function postDelivery(
  url: string,
  payload: Record<string, unknown>,
): Promise<DeliveryOutcome> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: "unreachable" };
  }

  if (res.status === 404) return { kind: "not_owned" };

  const text = await res.text();
  if (res.ok) return { kind: "delivered" };

  let detail = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === "string") detail = parsed.error;
  } catch {
    /* keep raw text */
  }
  return { kind: "rejected", error: `(${res.status}): ${detail}` };
}

async function loadTelegramConfig(): Promise<TelegramConfig> {
  const envFile =
    process.env.TELEGRAM_BOT_ENV_FILE?.trim() || DEFAULT_TELEGRAM_ENV_FILE;
  let fileEnv: Record<string, string> = {};

  try {
    fileEnv = dotenv.parse(await readFile(envFile));
  } catch {
    // Explicit process variables are also supported, so a missing sibling repo
    // is not itself an error.
  }

  const setting = (name: string): string =>
    process.env[name]?.trim() || fileEnv[name]?.trim() || "";
  const token = setting("TELEGRAM_BOT_TOKEN");
  const chatId = setting("TELEGRAM_ALLOWED_USER_ID");

  if (!token || !chatId) {
    throw new Error(
      `Telegram delivery is not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID, or point TELEGRAM_BOT_ENV_FILE at the bot's .env (checked ${envFile})`,
    );
  }

  return {
    token,
    chatId,
    apiRoot:
      setting("TELEGRAM_API_ROOT").replace(/\/+$/, "") ||
      "https://api.telegram.org",
    proxyUrl: setting("TELEGRAM_PROXY_URL"),
    proxySecret: setting("TELEGRAM_PROXY_SECRET"),
  };
}

async function sendToTelegram(
  filePath: string,
  caption?: string,
): Promise<"photo" | "document"> {
  if (!path.isAbsolute(filePath)) {
    throw new Error("send_file_to_user requires an absolute file path");
  }
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }

  const config = await loadTelegramConfig();
  const isPhoto = PHOTO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  const method = isPhoto ? "sendPhoto" : "sendDocument";
  const field = isPhoto ? "photo" : "document";
  const form = new FormData();
  form.set("chat_id", config.chatId);
  if (caption) form.set("caption", caption);
  form.set(
    field,
    new File([await readFile(filePath)], path.basename(filePath), {
      type: isPhoto
        ? `image/${path.extname(filePath).slice(1).replace("jpg", "jpeg")}`
        : "application/octet-stream",
    }),
  );

  const dispatcher = config.proxyUrl
    ? new ProxyAgent(config.proxyUrl)
    : undefined;
  try {
    const response = await undiciFetch(
      `${config.apiRoot}/bot${config.token}/${method}`,
      {
        method: "POST",
        headers: config.proxySecret
          ? { "X-Proxy-Secret": config.proxySecret }
          : undefined,
        body: form,
        dispatcher,
      },
    );
    const result = (await response.json()) as {
      ok?: boolean;
      description?: string;
    };
    if (!response.ok || !result.ok) {
      throw new Error(
        result.description || `Telegram API returned HTTP ${response.status}`,
      );
    }
  } finally {
    await dispatcher?.close();
  }

  return isPhoto ? "photo" : "document";
}

export const SendFilePlugin: Plugin = async () => ({
  tool: {
    send_file_to_user: tool({
      description:
        "Deliver a local file directly to the user. Use this when the user asks you to send or show them a file or picture — e.g. after you download or generate an image. Pass an absolute path to a file that already exists on disk. In a Gmail-owned session the file is attached to the reply; otherwise it is sent directly to the user's configured Telegram chat, with images sent as photos and other files as documents.",
      args: {
        path: z
          .string()
          .describe(
            "Absolute path to an existing local file to send to the user",
          ),
        caption: z
          .string()
          .optional()
          .describe(
            "Optional short caption to show alongside the file (Telegram only)",
          ),
      },
      async execute(args, ctx) {
        const payload = {
          sessionID: ctx.sessionID,
          path: args.path,
          caption: args.caption,
        };

        // Gmail can identify whether it owns this session. If it does not, send
        // straight through Telegram's Bot API using the bot project's env.
        const gmail = await postDelivery(GMAIL_DELIVERY_URL, payload);
        if (gmail.kind === "delivered") {
          return `Attached ${args.path} to my email reply for this thread; it will arrive with my next message.`;
        }
        if (gmail.kind === "rejected") {
          throw new Error(`send_file_to_user failed via Gmail ${gmail.error}`);
        }

        const sentAs = await sendToTelegram(args.path, args.caption);
        return `Delivered ${args.path} to the user via Telegram as a ${sentAs}.`;
      },
    }),
  },
});

export default SendFilePlugin;
