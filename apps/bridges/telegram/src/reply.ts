import type { TelegramApi } from "./telegram.ts";

const TELEGRAM_TEXT_LIMIT = 3900;

/**
 * Sends a turn's final result to Telegram as the ONLY reply for the
 * triggering message (T-125): a single `sendMessage` call — never
 * `editMessageText`, never a "Working..." placeholder sent ahead of it —
 * chunked only when the text exceeds Telegram's 4096-char message cap.
 */
export async function sendFinalReply(telegram: TelegramApi, chatId: number, replyToMessageId: number, text: string): Promise<void> {
	const chunks = splitTelegramText(text);
	await telegram.sendMessage(chatId, chunks[0]!, replyToMessageId);
	for (const chunk of chunks.slice(1)) await telegram.sendMessage(chatId, chunk);
}

export function splitTelegramText(text: string): string[] {
	const trimmed = text.trim() || "Turn complete.";
	const chunks: string[] = [];
	let rest = trimmed;
	while (rest.length > TELEGRAM_TEXT_LIMIT) {
		let cut = rest.lastIndexOf("\n", TELEGRAM_TEXT_LIMIT);
		if (cut < TELEGRAM_TEXT_LIMIT * 0.6) cut = TELEGRAM_TEXT_LIMIT;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	chunks.push(rest);
	return chunks;
}
