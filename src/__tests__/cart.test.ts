/**
 * Unit tests for pure cart functions.
 * No network, no Supabase.
 */

import { addToCart, incCart, decCart, filterAvailable, MAX_QTY } from "@/lib/handlers/cart";
import type { CartItem, MenuItemRow } from "@/types/database";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<MenuItemRow> = {}): MenuItemRow {
  return {
    id: "uuid-1",
    slug: "ice_latte",
    title: "Айс-латте",
    price_kop: 25000,
    variant_group: "syrup",
    field_item: true,
    available: true,
    sort_order: 10,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function makeCart(overrides: Partial<CartItem>[] = []): CartItem[] {
  return overrides.map((o) => ({
    slug: "ice_latte",
    title: "Айс-латте",
    variant: null,
    price_kop: 25000,
    qty: 1,
    ...o,
  }));
}

// ---------------------------------------------------------------------------
// addToCart
// ---------------------------------------------------------------------------

describe("addToCart", () => {
  it("adds a new item to an empty cart", () => {
    const item = makeItem();
    const { cart, capped } = addToCart([], item, null);
    expect(capped).toBe(false);
    expect(cart).toHaveLength(1);
    expect(cart[0].slug).toBe("ice_latte");
    expect(cart[0].qty).toBe(1);
    expect(cart[0].variant).toBeNull();
  });

  it("merges identical slug+variant into existing row (qty grows)", () => {
    const item = makeItem();
    const initial = makeCart([{ slug: "ice_latte", variant: "С сиропом", qty: 1 }]);
    const { cart, capped } = addToCart(initial, item, "С сиропом");
    expect(capped).toBe(false);
    expect(cart).toHaveLength(1);
    expect(cart[0].qty).toBe(2);
  });

  it("creates separate row for same slug but different variant", () => {
    const item = makeItem();
    const initial = makeCart([{ slug: "ice_latte", variant: "С сиропом", qty: 1 }]);
    const { cart, capped } = addToCart(initial, item, "Без сиропа");
    expect(capped).toBe(false);
    expect(cart).toHaveLength(2);
    expect(cart[0].variant).toBe("С сиропом");
    expect(cart[1].variant).toBe("Без сиропа");
  });

  it("does NOT increase qty beyond MAX_QTY and returns capped=true", () => {
    const item = makeItem();
    const initial = makeCart([{ slug: "ice_latte", variant: null, qty: MAX_QTY }]);
    const { cart, capped } = addToCart(initial, item, null);
    expect(capped).toBe(true);
    expect(cart[0].qty).toBe(MAX_QTY); // unchanged
  });

  it("adds different slugs as separate rows", () => {
    const latte = makeItem({ slug: "ice_latte", title: "Айс-латте" });
    const lemon = makeItem({ slug: "sour_lemonade", title: "Кислый лимонад", variant_group: null });
    const { cart: cart1 } = addToCart([], latte, null);
    const { cart: cart2 } = addToCart(cart1, lemon, null);
    expect(cart2).toHaveLength(2);
    expect(cart2[0].slug).toBe("ice_latte");
    expect(cart2[1].slug).toBe("sour_lemonade");
  });
});

// ---------------------------------------------------------------------------
// incCart
// ---------------------------------------------------------------------------

describe("incCart", () => {
  it("increments qty of the item at idx", () => {
    const cart = makeCart([{ qty: 3 }]);
    const { cart: next, capped, notFound } = incCart(cart, 0);
    expect(notFound).toBe(false);
    expect(capped).toBe(false);
    expect(next[0].qty).toBe(4);
  });

  it("returns notFound=true when idx is out of range", () => {
    const cart = makeCart([{ qty: 1 }]);
    const { notFound } = incCart(cart, 5);
    expect(notFound).toBe(true);
  });

  it("returns notFound=true when idx is negative", () => {
    const cart = makeCart([{ qty: 1 }]);
    const { notFound } = incCart(cart, -1);
    expect(notFound).toBe(true);
  });

  it("returns capped=true when qty is already MAX_QTY", () => {
    const cart = makeCart([{ qty: MAX_QTY }]);
    const { capped, notFound, cart: next } = incCart(cart, 0);
    expect(notFound).toBe(false);
    expect(capped).toBe(true);
    expect(next[0].qty).toBe(MAX_QTY); // unchanged
  });

  it("returns notFound=true for empty cart", () => {
    const { notFound } = incCart([], 0);
    expect(notFound).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decCart
// ---------------------------------------------------------------------------

describe("decCart", () => {
  it("decrements qty when qty > 1", () => {
    const cart = makeCart([{ qty: 3 }]);
    const { cart: next, removed, notFound } = decCart(cart, 0);
    expect(notFound).toBe(false);
    expect(removed).toBe(false);
    expect(next[0].qty).toBe(2);
  });

  it("removes the item when qty == 1 (removed=true)", () => {
    const cart = makeCart([{ qty: 1 }]);
    const { cart: next, removed, notFound } = decCart(cart, 0);
    expect(notFound).toBe(false);
    expect(removed).toBe(true);
    expect(next).toHaveLength(0);
  });

  it("returns notFound=true when idx is out of range", () => {
    const cart = makeCart([{ qty: 2 }]);
    const { notFound } = decCart(cart, 10);
    expect(notFound).toBe(true);
  });

  it("returns notFound=true when idx is negative", () => {
    const cart = makeCart([{ qty: 2 }]);
    const { notFound } = decCart(cart, -1);
    expect(notFound).toBe(true);
  });

  it("results in empty cart after removing last item", () => {
    const cart = makeCart([{ qty: 1 }]);
    const { cart: next } = decCart(cart, 0);
    expect(next).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cart becomes empty after decrementing all items
// ---------------------------------------------------------------------------

describe("cart becomes empty after removing all items", () => {
  it("sequential dec operations empty the cart", () => {
    let cart = makeCart([{ qty: 1 }, { slug: "sour_lemonade", qty: 1 }]);
    const r1 = decCart(cart, 1);
    cart = r1.cart;
    expect(cart).toHaveLength(1);

    const r2 = decCart(cart, 0);
    cart = r2.cart;
    expect(cart).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// filterAvailable
// ---------------------------------------------------------------------------

describe("filterAvailable", () => {
  const availableItem: MenuItemRow = makeItem({ slug: "ice_latte", available: true });
  const unavailableItem: MenuItemRow = makeItem({ slug: "coffee_tonic", title: "Кофе-тоник", available: false });

  it("keeps available items", () => {
    const cart = makeCart([{ slug: "ice_latte" }]);
    const { cart: filtered, dropped } = filterAvailable(cart, [availableItem]);
    expect(filtered).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("drops unavailable items and returns their titles", () => {
    const cart = makeCart([
      { slug: "ice_latte" },
      { slug: "coffee_tonic", title: "Кофе-тоник" },
    ]);
    const { cart: filtered, dropped } = filterAvailable(cart, [availableItem, unavailableItem]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].slug).toBe("ice_latte");
    expect(dropped).toContain("Кофе-тоник");
  });

  it("returns empty cart when all items are unavailable", () => {
    const cart = makeCart([{ slug: "coffee_tonic", title: "Кофе-тоник" }]);
    const { cart: filtered, dropped } = filterAvailable(cart, [unavailableItem]);
    expect(filtered).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });
});
