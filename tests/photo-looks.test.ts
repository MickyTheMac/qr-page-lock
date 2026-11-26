import { describe, expect, it } from "vitest";
import { judgeLooks, looksMessage, scoreAlignment, targetRect, TARGET_RATIO } from "../src/lib/pagelock";

describe("does the picture look like the chosen document?", () => {
  it("recognises a driving licence by its words, even with small reading errors", () => {
    expect(judgeLooks("Driving licence", "DRIVING LICENCE | 1. Surname | MORGAN").result).toBe("recognised");
    expect(judgeLooks("Driving licence", "DRIV1NG LICENGE\nUNITED KINGDOM").result).toBe("recognised");
  });
  it("a selfie (no words) is not a licence", () => {
    const r = judgeLooks("Driving licence", "  \n ");
    expect(r.result).toBe("not-recognised");
    expect(looksMessage(r)).toMatch(/^Hang on: PageLock can't see a driving licence/);
  });
  it("says when it looks like a different document", () => {
    const r = judgeLooks("Driving licence", "PASSPORT\nP<GBRMORGAN<<ALEX<JORDAN<<<<<<<<<<<<<<<<<<<");
    expect(r.result).toBe("not-recognised");
    expect(r.looksLike).toBe("Passport");
    expect(judgeLooks("Passport", "P<GBRMORGAN<<ALEX<JORDAN<<<<<<<<<<<<<<<<<<<").result).toBe("recognised");
    expect(judgeLooks("ID card", "SAMPLE ID CARD | SPECIMEN").result).toBe("recognised");
  });
  it("a document needs some writing; Other is not checked", () => {
    expect(judgeLooks("Document", "This agreement is made between the parties named below on the date shown").result).toBe("recognised");
    expect(judgeLooks("Document", "").result).toBe("not-recognised");
    expect(judgeLooks("Other", "").result).toBe("skipped");
  });
});

describe("the target", () => {
  const W = 320;
  const H = 240;
  const t = targetRect(W, H, TARGET_RATIO["Driving licence"]!);
  const image = (card: { x: number; y: number; w: number; h: number } | null) => {
    const g = new Uint8Array(W * H).fill(40);
    if (card) for (let y = Math.round(card.y); y < card.y + card.h; y++) for (let x = Math.round(card.x); x < card.x + card.w; x++) g[y * W + x] = 220;
    return g;
  };
  it("is lined up when a card's edges sit on the frame", () => {
    expect(scoreAlignment(image(t), W, H, t).aligned).toBe(true);
    expect(scoreAlignment(image({ x: t.x + 3, y: t.y - 2, w: t.w - 4, h: t.h + 3 }), W, H, t).aligned).toBe(true);
  });
  it("is not lined up when the card is too small, missing or a face", () => {
    expect(scoreAlignment(image({ x: t.x + 40, y: t.y + 30, w: t.w - 80, h: t.h - 60 }), W, H, t).aligned).toBe(false);
    expect(scoreAlignment(image(null), W, H, t).aligned).toBe(false);
    const face = new Uint8Array(W * H).fill(180);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - 160) ** 2 / 60 ** 2 + (y - 110) ** 2 / 80 ** 2 < 1) face[y * W + x] = 120;
    expect(scoreAlignment(face, W, H, t).aligned).toBe(false);
  });
});
