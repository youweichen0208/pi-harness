import type { UiMessage } from "../../server/protocol.js";

/** A completed greeting deserves a useful localized label, while a manual
 * session name remains authoritative. This also covers old unnamed chats. */
export function conversationDisplayTitle(title: string, firstMessage: string | undefined, name: string | undefined, messageCount: number, locale: "zh" | "en", messages?: readonly UiMessage[]): string {
	if (name?.trim()) return name;
	const first = (firstMessage || title).trim();
	if (messageCount > 1 && /^(?:hi|hello|hey|你好|您好|嗨|哈喽)[\s!！?？.。~～]*$/iu.test(first)) {
		const request = messages?.filter((message) => message.role === "user")
			.map((message) => message.content.filter((block) => block.type === "text").map((block) => block.type === "text" ? block.text : "").join(" ").trim())
			.find((text) => text && !/^(?:hi|hello|hey|你好|您好|嗨|哈喽)[\s!！?？.。~～]*$/iu.test(text) && !text.startsWith("【目标已设定】") && !text.startsWith("✅ 目标已达成"));
		if (request) return Array.from(request).slice(0, 24).join("") + (Array.from(request).length > 24 ? "…" : "");
		if (locale === "zh") return "打招呼";
	}
	// Skill runs read as "grill-with-docs · question"; the prefix only costs title width.
	return title.replace(/^skill:(?=\S)/, "");
}
