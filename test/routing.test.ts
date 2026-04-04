import { describe, expect, it } from "vitest";
import { resolveRouteTargets } from "../src/routing/rules";
import type { RouteConfig } from "../src/config";
import { loadRouteConfig } from "../src/config";
import { formatTelegramMessage } from "../src/telegram/format";

const routeConfig: RouteConfig = {
  default: {
    telegramChats: ["10001"],
    emails: ["default@example.com"]
  },
  routes: [
    {
      prefix: "github+",
      telegramChats: ["20001", "20002"],
      emails: ["dev@example.com"]
    }
  ]
};

describe("route resolution", () => {
  it("matches configured prefix", () => {
    const result = resolveRouteTargets("github+bot@domain.com", routeConfig);
    expect(result.routeKey).toBe("github+");
    expect(result.telegramChats).toEqual(["20001", "20002"]);
    expect(result.emails).toEqual(["dev@example.com"]);
  });

  it("falls back to default route", () => {
    const result = resolveRouteTargets("notice@domain.com", routeConfig);
    expect(result.routeKey).toBe("default");
    expect(result.telegramChats).toEqual(["10001"]);
  });
});

describe("telegram format", () => {
  it("shows short format when AI extracted high-confidence signal", () => {
    const text = formatTelegramMessage(
      {
        from: "no-reply@service.com",
        to: "github+bot@domain.com",
        subject: "verification",
        date: "",
        messageId: "id",
        text: "your code is 123456",
        html: "",
        raw: "",
        receivedAt: new Date().toISOString()
      },
      { codeOrLink: "123456", confidence: 0.99, service: "GitHub" }
    );
    expect(text).toContain("123456");
    expect(text).toContain("Service: GitHub");
    expect(text).not.toContain("Snippet:");
  });

  it("shows full format when confidence is low", () => {
    const text = formatTelegramMessage(
      {
        from: "no-reply@service.com",
        to: "github+bot@domain.com",
        subject: "newsletter",
        date: "",
        messageId: "id",
        text: "hello world",
        html: "",
        raw: "",
        receivedAt: new Date().toISOString()
      },
      { codeOrLink: "", confidence: 0, service: "" }
    );
    expect(text).toContain("Mail arrived");
    expect(text).toContain("Snippet:");
  });
});

describe("route config source", () => {
  it("loads route config from D1", async () => {
    const db = {
      prepare: () => ({
        all: async () => ({
          results: [
            { prefix: "*", telegram_chats: '["999"]', emails: "[]" }
          ]
        })
      })
    } as unknown as D1Database;

    const cfg = await loadRouteConfig({
      TELEGRAM_BOT_TOKEN: "t",
      DEFAULT_FORWARD_EMAIL: "x@example.com",
      DB: db,
      AI: {} as Ai
    });

    expect(cfg.default.telegramChats).toEqual(["999"]);
  });
});
