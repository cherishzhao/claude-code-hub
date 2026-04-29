import type { ClientFormat } from "./format-mapper";
import type { ProxySession } from "./session";

interface MessageLike {
  role?: string;
  content?: unknown;
  parts?: unknown;
}

function extractLastUserMessageFromArray(messages: unknown[], format: ClientFormat): string | null {
  if (messages.length === 0) {
    return null;
  }

  if (format === "response") {
    const last = messages[messages.length - 1];
    if (last === undefined || last === null) {
      return null;
    }
    return typeof last === "string" ? last : JSON.stringify(last);
  }

  let last: MessageLike | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m === "object" && m !== null && (m as MessageLike).role === "user") {
      last = m as MessageLike;
      break;
    }
  }

  if (!last) {
    return null;
  }

  if (format === "gemini" || format === "gemini-cli") {
    const parts = last.parts;
    if (parts === undefined || parts === null) {
      return null;
    }
    return typeof parts === "string" ? parts : JSON.stringify(parts);
  }

  const content = last.content;
  if (content === undefined || content === null) {
    return null;
  }
  return typeof content === "string" ? content : JSON.stringify(content);
}

export function extractUserQuery(session: ProxySession): string | null {
  const messages = session.getMessages();
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  return extractLastUserMessageFromArray(messages, session.originalFormat);
}
