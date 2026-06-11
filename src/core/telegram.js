/**
 * Minimal Telegram message sender.
 * Reads configuration from environment variables:
 * - TELEGRAM_BOT_TOKEN
 * - TELEGRAM_CHAT_IDS (comma-separated list)
 */

function normalizeChatIds(value) {
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export function getTelegramConfig(env = process.env) {
  return getTelegramConfigForKind(env, 'default');
}

export function getTelegramConfigForKind(env = process.env, kind = 'default') {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatIdValue =
    kind === 'morning'
      ? (env.TELEGRAM_MORNING_CHAT_IDS || env.TELEGRAM_CHAT_IDS || env.TELEGRAM_CHAT_ID)
      : kind === 'alerts'
        ? (env.TELEGRAM_ALERT_CHAT_IDS || env.TELEGRAM_CHAT_IDS || env.TELEGRAM_CHAT_ID)
        : (env.TELEGRAM_CHAT_IDS || env.TELEGRAM_CHAT_ID);
  const chatIds = [...new Set(normalizeChatIds(chatIdValue))];

  return {
    botToken,
    chatIds,
    enabled: Boolean(botToken && chatIds.length),
  };
}

function splitTelegramText(text, maxLen = 3900) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else if (candidate.length > maxLen) {
      chunks.push(line.slice(0, maxLen));
      current = "";
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function sendTelegramMessage({
  botToken,
  chatId,
  text,
  disablePreview = true,
}) {
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  if (!chatId) throw new Error("chatId is missing");
  if (!text) throw new Error("text is missing");

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: disablePreview,
  };

  const sendOnce = async (targetChatId) => {
    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          chat_id: targetChatId,
        }),
      },
    );

    const data = await resp.json().catch(() => ({}));
    return { resp, data };
  };

  let { resp, data } = await sendOnce(chatId);
  const migrateTo = data?.parameters?.migrate_to_chat_id;

  if (
    (!resp.ok || !data.ok) &&
    migrateTo &&
    String(migrateTo) !== String(chatId)
  ) {
    console.warn(
      `[telegram] chat ${chatId} migrated to ${migrateTo}; retrying sendMessage`,
    );
    ({ resp, data } = await sendOnce(migrateTo));
  }

  if (!resp.ok || !data.ok) {
    throw new Error(
      data?.description ||
        `Telegram sendMessage failed with HTTP ${resp.status}`,
    );
  }

  return data.result;
}

export async function sendTelegramBroadcast({
  botToken,
  chatIds,
  text,
  disablePreview = true,
}) {
  const results = [];
  const chunks = splitTelegramText(text);
  for (const chatId of chatIds) {
    const sentMessages = [];
    for (const chunk of chunks) {
      const result = await sendTelegramMessage({
        botToken,
        chatId,
        text: chunk,
        disablePreview,
      });
      sentMessages.push(result?.message_id || null);
    }
    results.push({ chatId, messageIds: sentMessages });
  }
  return { success: true, sent_to: results };
}
