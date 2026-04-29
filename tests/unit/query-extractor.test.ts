import { describe, expect, test } from "vitest";
import { extractUserQuery } from "@/app/v1/_lib/proxy/query-extractor";
import type { ClientFormat } from "@/app/v1/_lib/proxy/format-mapper";

function createMockSession(messages: Record<string, unknown>, format: ClientFormat) {
  return {
    request: { message: messages },
    originalFormat: format,
    getMessages() {
      const msg = this.request.message;
      if (msg.messages !== undefined) return msg.messages;
      if (msg.input !== undefined) return msg.input;
      if (msg.contents !== undefined) return msg.contents;
      const req = msg.request as Record<string, unknown> | undefined;
      if (req?.contents !== undefined) return req.contents;
      return undefined;
    },
  } as Parameters<typeof extractUserQuery>[0];
}

describe("extractUserQuery", () => {
  describe("Claude/OpenAI format", () => {
    test("extracts last user message content from messages array", () => {
      const session = createMockSession(
        {
          messages: [
            { role: "user", content: "first question" },
            { role: "assistant", content: "answer" },
            { role: "user", content: "follow up question" },
          ],
        },
        "claude"
      );
      expect(extractUserQuery(session)).toBe("follow up question");
    });

    test("extracts complex content as JSON string", () => {
      const complexContent = [
        { type: "text", text: "describe this image" },
        { type: "image", source: { type: "base64", data: "abc123" } },
      ];
      const session = createMockSession(
        {
          messages: [{ role: "user", content: complexContent }],
        },
        "openai"
      );
      expect(extractUserQuery(session)).toBe(JSON.stringify(complexContent));
    });

    test("returns null when no user messages exist", () => {
      const session = createMockSession(
        {
          messages: [
            { role: "system", content: "you are helpful" },
            { role: "assistant", content: "hello" },
          ],
        },
        "claude"
      );
      expect(extractUserQuery(session)).toBeNull();
    });

    test("returns null for empty messages array", () => {
      const session = createMockSession({ messages: [] }, "claude");
      expect(extractUserQuery(session)).toBeNull();
    });
  });

  describe("Codex/Response format", () => {
    test("extracts last element from input array", () => {
      const session = createMockSession(
        {
          input: [
            { role: "user", content: "first" },
            { role: "assistant", content: "response" },
            { role: "user", content: "latest input" },
          ],
        },
        "response"
      );
      const result = extractUserQuery(session);
      expect(result).toBe(JSON.stringify({ role: "user", content: "latest input" }));
    });

    test("extracts string input directly", () => {
      const session = createMockSession({ input: ["write a hello world program"] }, "response");
      expect(extractUserQuery(session)).toBe("write a hello world program");
    });
  });

  describe("Gemini format", () => {
    test("extracts last user message parts from contents array", () => {
      const session = createMockSession(
        {
          contents: [
            {
              role: "user",
              parts: [{ text: "first question" }],
            },
            {
              role: "model",
              parts: [{ text: "answer" }],
            },
            {
              role: "user",
              parts: [{ text: "follow up" }],
            },
          ],
        },
        "gemini"
      );
      expect(extractUserQuery(session)).toBe(JSON.stringify([{ text: "follow up" }]));
    });

    test("handles gemini-cli wrapper format", () => {
      const session = createMockSession(
        {
          request: {
            contents: [{ role: "user", parts: [{ text: "cli question" }] }],
          },
        },
        "gemini-cli"
      );
      expect(extractUserQuery(session)).toBe(JSON.stringify([{ text: "cli question" }]));
    });

    test("returns null when no user role in gemini contents", () => {
      const session = createMockSession(
        {
          contents: [{ role: "model", parts: [{ text: "hello" }] }],
        },
        "gemini"
      );
      expect(extractUserQuery(session)).toBeNull();
    });
  });

  describe("edge cases", () => {
    test("returns null when messages field is missing", () => {
      const session = createMockSession({}, "claude");
      expect(extractUserQuery(session)).toBeNull();
    });

    test("handles large content without truncation", () => {
      const largeContent = "x".repeat(200_000);
      const session = createMockSession(
        {
          messages: [{ role: "user", content: largeContent }],
        },
        "claude"
      );
      const result = extractUserQuery(session);
      expect(result).toBe(largeContent);
      expect(result!.length).toBe(200_000);
    });
  });
});
