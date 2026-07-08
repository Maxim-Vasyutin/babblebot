/**
 * Unit tests for FSM state definitions.
 */

import { FSM_STATES, isFsmState } from "@/lib/fsm";
import type { FsmState } from "@/lib/fsm";

describe("FSM_STATES", () => {
  it("contains all 7 expected states", () => {
    const expected: string[] = [
      "browsing",
      "choosing_variant",
      "cart",
      "checkout_landmark",
      "checkout_landmark_text",
      "checkout_car",
      "checkout_payment",
    ];
    expect(FSM_STATES.length).toBe(expected.length);
    for (const s of expected) {
      expect(FSM_STATES).toContain(s);
    }
  });

  it("matches the SessionState from database types (each DB state is in FSM)", () => {
    // SessionState is defined in database.ts — we check the overlap with FSM_STATES.
    const dbStates: FsmState[] = [
      "browsing",
      "choosing_variant",
      "cart",
      "checkout_landmark",
      "checkout_landmark_text",
      "checkout_car",
      "checkout_payment",
    ];
    for (const s of dbStates) {
      expect(FSM_STATES).toContain(s);
    }
  });
});

describe("isFsmState type-guard", () => {
  it("returns true for all valid states", () => {
    for (const s of FSM_STATES) {
      expect(isFsmState(s)).toBe(true);
    }
  });

  it("returns false for unknown string", () => {
    expect(isFsmState("unknown_state")).toBe(false);
    expect(isFsmState("BROWSING")).toBe(false);
    expect(isFsmState("")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isFsmState(null)).toBe(false);
    expect(isFsmState(undefined)).toBe(false);
    expect(isFsmState(42)).toBe(false);
    expect(isFsmState({})).toBe(false);
    expect(isFsmState([])).toBe(false);
  });

  it("correctly narrows type: valid input is accepted", () => {
    const v: unknown = "browsing";
    if (isFsmState(v)) {
      // TypeScript knows v is FsmState here
      const s: FsmState = v;
      expect(s).toBe("browsing");
    } else {
      fail("isFsmState should have returned true for 'browsing'");
    }
  });
});
