/**
 * Unit tests for formatting utilities.
 */

import {
  formatRub,
  cartTotalKop,
  cartTotalQty,
  userTag,
  renderCartLines,
  renderBulletLines,
} from "@/lib/handlers/format";
import type { CartItem } from "@/types/database";

// ---------------------------------------------------------------------------
// formatRub
// ---------------------------------------------------------------------------

describe("formatRub()", () => {
  it("converts 25000 kopecks to '250₽'", () => {
    expect(formatRub(25000)).toBe("250₽");
  });

  it("converts 0 kopecks to '0₽'", () => {
    expect(formatRub(0)).toBe("0₽");
  });

  it("converts 100 kopecks to '1₽'", () => {
    expect(formatRub(100)).toBe("1₽");
  });

  it("converts 75000 kopecks to '750₽'", () => {
    expect(formatRub(75000)).toBe("750₽");
  });

  it("rounds half up for non-round kopeck values", () => {
    // 25050 → 250.5 → rounds to 251
    expect(formatRub(25050)).toBe("251₽");
  });
});

// ---------------------------------------------------------------------------
// cartTotalKop
// ---------------------------------------------------------------------------

describe("cartTotalKop()", () => {
  function makeItem(slug: string, price_kop: number, qty: number): CartItem {
    return { slug, title: slug, variant: null, price_kop, qty };
  }

  it("returns 0 for empty cart", () => {
    expect(cartTotalKop([])).toBe(0);
  });

  it("sums price_kop * qty for single item", () => {
    expect(cartTotalKop([makeItem("a", 25000, 2)])).toBe(50000);
  });

  it("sums multiple items correctly", () => {
    const cart = [
      makeItem("ice_latte", 25000, 2),   // 50000
      makeItem("sandwich", 25000, 1),    // 25000
    ];
    expect(cartTotalKop(cart)).toBe(75000);
  });

  it("handles variant items the same way", () => {
    const cart: CartItem[] = [
      { slug: "ice_latte", title: "Айс-латте", variant: "С сиропом", price_kop: 25000, qty: 3 },
    ];
    expect(cartTotalKop(cart)).toBe(75000);
  });
});

// ---------------------------------------------------------------------------
// cartTotalQty
// ---------------------------------------------------------------------------

describe("cartTotalQty()", () => {
  it("returns 0 for empty cart", () => {
    expect(cartTotalQty([])).toBe(0);
  });

  it("sums all qty values", () => {
    const cart: CartItem[] = [
      { slug: "a", title: "A", variant: null, price_kop: 100, qty: 2 },
      { slug: "b", title: "B", variant: null, price_kop: 100, qty: 3 },
    ];
    expect(cartTotalQty(cart)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// userTag — edge case #10 (юзер без username)
// ---------------------------------------------------------------------------

describe("userTag() — edge case #10", () => {
  it("returns '@username' when username is present", () => {
    expect(userTag("driver_ivan", 12345)).toBe("@driver_ivan");
  });

  it("returns 'id <number>' when username is null (#10)", () => {
    expect(userTag(null, 555000111)).toBe("id 555000111");
  });

  it("returns 'id <number>' when username is empty string", () => {
    expect(userTag("", 999)).toBe("id 999");
  });

  it("escapes HTML in username", () => {
    expect(userTag("<evil>", 1)).toBe("@&lt;evil&gt;");
  });
});

// ---------------------------------------------------------------------------
// renderCartLines
// ---------------------------------------------------------------------------

describe("renderCartLines()", () => {
  it("formats numbered list with prices", () => {
    const cart: CartItem[] = [
      { slug: "ice_latte", title: "Айс-латте", variant: "С сиропом", price_kop: 25000, qty: 2 },
    ];
    const result = renderCartLines(cart);
    // Should contain index, title with variant, qty, and sum
    expect(result).toContain("1.");
    expect(result).toContain("Айс-латте");
    expect(result).toContain("×2");
    expect(result).toContain("500₽");
  });

  it("escapes HTML in title", () => {
    const cart: CartItem[] = [
      { slug: "evil", title: "<b>latte</b>", variant: null, price_kop: 25000, qty: 1 },
    ];
    const result = renderCartLines(cart);
    expect(result).not.toContain("<b>");
    expect(result).toContain("&lt;b&gt;");
  });
});

// ---------------------------------------------------------------------------
// renderBulletLines
// ---------------------------------------------------------------------------

describe("renderBulletLines()", () => {
  it("formats bullet list without index or sum", () => {
    const cart: CartItem[] = [
      { slug: "ice_latte", title: "Айс-латте", variant: "С сиропом", price_kop: 25000, qty: 2 },
    ];
    const result = renderBulletLines(cart);
    expect(result).toContain("•");
    expect(result).toContain("Айс-латте");
    expect(result).toContain("×2");
    // Should not contain pricing
    expect(result).not.toContain("500₽");
  });
});

// ---------------------------------------------------------------------------
// Cart total aggregation
// ---------------------------------------------------------------------------

describe("cart aggregation — total for display", () => {
  it("produces correct total for mixed cart", () => {
    const cart: CartItem[] = [
      { slug: "ice_latte", title: "Айс-латте", variant: "С сиропом", price_kop: 25000, qty: 2 },
      { slug: "sand_cheese", title: "Сэндвич сыр-ветчина", variant: null, price_kop: 25000, qty: 1 },
    ];
    expect(cartTotalKop(cart)).toBe(75000);
    expect(formatRub(cartTotalKop(cart))).toBe("750₽");
  });
});
