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
  it("shows OTP line when AI extracted code", () => {
    const text = formatTelegramMessage(
      {
        from: "no-reply@service.com",
        to: "github+bot@domain.com",
        subject: "verification",
        date: "",
        messageId: "id",
        text: "your code is 123456",
        html: "",
        receivedAt: new Date().toISOString()
      },
      { code: "123456", confidence: 0.99, service: "service.com" }
    );
    expect(text).toContain("OTP: 123456");
  });
});

describe("route config source", () => {
  it("loads route config from KV", async () => {
    const kv = {
      get: async () =>
        JSON.stringify({
          default: { telegramChats: ["999"], emails: [] },
          routes: []
        })
    } as unknown as KVNamespace;

    const cfg = await loadRouteConfig({
      TELEGRAM_BOT_TOKEN: "t",
      DEFAULT_FORWARD_EMAIL: "x@example.com",
      ROUTE_CONFIG_STORE: kv,
      AI: {} as Ai
    });

    expect(cfg.default.telegramChats).toEqual(["999"]);
  });
});
