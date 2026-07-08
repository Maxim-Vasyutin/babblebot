/**
 * Unit tests for Zod schemas: TgUpdate and CallbackData.
 */

import { TgUpdate, CallbackData } from "@/lib/schemas";

// ---------------------------------------------------------------------------
// TgUpdate
// ---------------------------------------------------------------------------

describe("TgUpdate", () => {
  const validCallback = {
    update_id: 123456789,
    callback_query: {
      id: "cb_abc",
      from: { id: 555000111, username: "driver_ivan" },
      message: {
        message_id: 42,
        chat: { id: 555000111, type: "private" },
        from: { id: 555000111, username: "driver_ivan" },
      },
      data: "menu",
    },
  };

  const validMessage = {
    update_id: 987654321,
    message: {
      message_id: 7,
      chat: { id: 111222333, type: "private" },
      from: { id: 111222333, username: "some_user" },
      text: "/start",
    },
  };

  it("parses a valid update with callback_query", () => {
    const result = TgUpdate.safeParse(validCallback);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.update_id).toBe(123456789);
      expect(result.data.callback_query?.id).toBe("cb_abc");
      expect(result.data.callback_query?.from.id).toBe(555000111);
    }
  });

  it("parses a valid update with message", () => {
    const result = TgUpdate.safeParse(validMessage);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.update_id).toBe(987654321);
      expect(result.data.message?.text).toBe("/start");
      expect(result.data.message?.chat.type).toBe("private");
    }
  });

  it("returns error for invalid object (missing update_id)", () => {
    const result = TgUpdate.safeParse({ message: { message_id: 1, chat: { id: 1, type: "private" } } });
    expect(result.success).toBe(false);
  });

  it("returns error for non-integer update_id", () => {
    const result = TgUpdate.safeParse({ update_id: "abc" });
    expect(result.success).toBe(false);
  });

  it("returns error for completely empty object", () => {
    const result = TgUpdate.safeParse({});
    expect(result.success).toBe(false);
  });

  it("parses update without username (username is optional)", () => {
    const result = TgUpdate.safeParse({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 1, type: "private" },
        from: { id: 42 }, // no username
        text: "/start",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message?.from?.username).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// CallbackData
// ---------------------------------------------------------------------------

describe("CallbackData", () => {
  it("validates 'menu'", () => {
    expect(CallbackData.safeParse("menu").success).toBe(true);
  });

  it("validates 'item:ice_latte'", () => {
    expect(CallbackData.safeParse("item:ice_latte").success).toBe(true);
  });

  it("validates 'var:ice_latte:syrup_yes'", () => {
    expect(CallbackData.safeParse("var:ice_latte:syrup_yes").success).toBe(true);
  });

  it("validates 'adm_status:<uuid>:delivered'", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const data = `adm_status:${uuid}:delivered`;
    // UUID contains dashes which the regex allows with \-
    const result = CallbackData.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("validates 'adm_stop:ice_latte'", () => {
    expect(CallbackData.safeParse("adm_stop:ice_latte").success).toBe(true);
  });

  it("validates 'cart'", () => {
    expect(CallbackData.safeParse("cart").success).toBe(true);
  });

  it("validates 'pay:cash'", () => {
    expect(CallbackData.safeParse("pay:cash").success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(CallbackData.safeParse("").success).toBe(false);
  });

  it("rejects string with spaces", () => {
    expect(CallbackData.safeParse("menu item").success).toBe(false);
  });

  it("rejects string with uppercase action", () => {
    expect(CallbackData.safeParse("MENU").success).toBe(false);
  });

  it("rejects string with three colons (too many parts)", () => {
    expect(CallbackData.safeParse("too:many:colons:here").success).toBe(false);
  });

  it("rejects string starting with colon", () => {
    expect(CallbackData.safeParse(":menu").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// callback_data byte-length check for adm_status (#18)
// ---------------------------------------------------------------------------

describe("callback_data byte length constraint (#18)", () => {
  it("adm_status:<uuid>:<status> fits within 64 bytes", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000"; // 36 chars
    const candidates = [
      `adm_status:${uuid}:in_progress`,
      `adm_status:${uuid}:delivered`,
      `adm_status:${uuid}:cancelled`,
    ];
    for (const c of candidates) {
      const bytes = Buffer.byteLength(c, "utf8");
      expect(bytes).toBeLessThanOrEqual(64);
    }
  });
});
