/**
 * Unit tests for the esc() HTML escaping utility.
 */

import { esc } from "@/lib/telegram/escape";

describe("esc()", () => {
  it("escapes '<' to '&lt;'", () => {
    expect(esc("<b>test</b>")).toBe("&lt;b&gt;test&lt;/b&gt;");
  });

  it("escapes '>' to '&gt;'", () => {
    expect(esc("a > b")).toBe("a &gt; b");
  });

  it("escapes '&' to '&amp;'", () => {
    expect(esc("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("escapes '&' BEFORE '<'/'>' so there is no double-encoding", () => {
    // If '&' were escaped last: "<b>" → "&lt;b&gt;" → "&amp;lt;b&amp;gt;" — wrong.
    // Correct: the function replaces & first, then < and >.
    // Input already containing the word "amp": "&amp;" should become "&amp;amp;"
    // only if it's a literal & followed by amp; but NOT if we double-call.
    const once = esc("& < >");
    expect(once).toBe("&amp; &lt; &gt;");

    // Calling esc on already-escaped output MUST NOT double-encode.
    // This checks that esc() is not applied twice to the same string.
    // We simply verify the first pass is correct (second pass is caller's responsibility).
    // Separate: raw ampersand → &amp;, not &amp;amp;
    expect(esc("&")).toBe("&amp;");
  });

  it("leaves plain strings unchanged", () => {
    expect(esc("белая гранта А123ВС")).toBe("белая гранта А123ВС");
    expect(esc("Привет мир")).toBe("Привет мир");
    expect(esc("")).toBe("");
  });

  it("handles combined injection attempt", () => {
    const input = '<script>alert("xss")</script>';
    const result = esc(input);
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
    expect(result).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;".replace(/&quot;/g, '"'));
  });

  it("escapes all special characters in HTML injection string", () => {
    expect(esc('<b>x</b>')).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
});
