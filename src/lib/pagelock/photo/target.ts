/**
 * The target drawn over the camera: a frame the shape of the document. The picture can only be taken once the
 * document's four edges sit on the frame's four sides, so it is the right size and fills the picture.
 *
 * Edge finding is deliberately simple and runs on a small grey copy of each camera frame, a few times a second:
 * along each side of the frame, it looks for a sharp change from light to dark (or dark to light) running the length
 * of that side, a little inside or outside it.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Width / height of each kind of document. Bank-card size for licences and ID cards (ID-1, 85.6 × 54 mm). */
export const TARGET_RATIO: Record<string, number | null> = {
  "Driving licence": 85.6 / 54,
  "ID card": 85.6 / 54,
  Passport: 125 / 88, // the photo page (ID-3)
  Document: 210 / 297, // A4, upright
  Other: null, // no target
};

/** The frame, centred, as large as it can be within 84% of the picture's width and 80% of its height. */
export function targetRect(frameW: number, frameH: number, ratio: number): Rect {
  let w = frameW * 0.84;
  let h = w / ratio;
  if (h > frameH * 0.8) {
    h = frameH * 0.8;
    w = h * ratio;
  }
  return { x: (frameW - w) / 2, y: (frameH - h) / 2, w, h };
}

/** What is kept: the frame plus a small margin, so the document's edges show in the sealed picture. */
export function cropRect(frameW: number, frameH: number, t: Rect): Rect {
  const m = Math.round(Math.min(t.w, t.h) * 0.04);
  const x = Math.max(0, Math.round(t.x - m));
  const y = Math.max(0, Math.round(t.y - m));
  return { x, y, w: Math.min(frameW, Math.round(t.x + t.w + m)) - x, h: Math.min(frameH, Math.round(t.y + t.h + m)) - y };
}

export interface SideScore {
  ok: boolean;
  /** How strong the edge is (average brightness step, 0-255). */
  strength: number;
  /** Share of the side where the edge was found (0-1). */
  coverage: number;
}

export interface AlignScore {
  sides: { top: SideScore; right: SideScore; bottom: SideScore; left: SideScore };
  aligned: boolean;
}

const MIN_STEP = 14; // brightness step that counts as an edge at one point
const MIN_COVERAGE = 0.65; // share of the side that must show the edge
const BAND = 0.06; // how far inside or outside the frame the edge may be (share of the shorter side)

/**
 * Checks whether a document's edges sit on the target. `gray` is one byte per pixel, rows top to bottom.
 */
export function scoreAlignment(gray: Uint8Array | Uint8ClampedArray, width: number, height: number, t: Rect): AlignScore {
  const px = (x: number, y: number) => gray[Math.min(height - 1, Math.max(0, Math.round(y))) * width + Math.min(width - 1, Math.max(0, Math.round(x)))];
  const band = Math.max(2, Math.round(Math.min(t.w, t.h) * BAND));
  const gap = 2; // compare pixels this far either side of the candidate edge

  // For one side: the edge line runs from (x0,y0) along (dx,dy); "across" is (nx,ny), pointing outwards.
  const side = (x0: number, y0: number, len: number, dx: number, dy: number, nx: number, ny: number): SideScore => {
    const samples = 28;
    let best: SideScore = { ok: false, strength: 0, coverage: 0 };
    for (let off = -band; off <= band; off++) {
      let hits = 0;
      let sum = 0;
      for (let i = 0; i < samples; i++) {
        const s = len * (0.15 + (0.7 * i) / (samples - 1)); // middle 70%: corners are rounded
        const cx = x0 + dx * s + nx * off;
        const cy = y0 + dy * s + ny * off;
        // Best step within one pixel either way, so a slightly tilted edge still counts.
        let step = 0;
        for (let j = -1; j <= 1; j++) {
          const ix = cx + nx * j;
          const iy = cy + ny * j;
          step = Math.max(step, Math.abs(px(ix - nx * gap, iy - ny * gap) - px(ix + nx * gap, iy + ny * gap)));
        }
        sum += step;
        if (step >= MIN_STEP) hits++;
      }
      const sc = { strength: sum / samples, coverage: hits / samples, ok: false };
      if (sc.coverage > best.coverage || (sc.coverage === best.coverage && sc.strength > best.strength)) best = sc;
    }
    return { ...best, ok: best.coverage >= MIN_COVERAGE };
  };

  const top = side(t.x, t.y, t.w, 1, 0, 0, -1);
  const bottom = side(t.x, t.y + t.h, t.w, 1, 0, 0, 1);
  const left = side(t.x, t.y, t.h, 0, 1, -1, 0);
  const right = side(t.x + t.w, t.y, t.h, 0, 1, 1, 0);
  return { sides: { top, right, bottom, left }, aligned: top.ok && right.ok && bottom.ok && left.ok };
}

/** RGBA to one grey byte per pixel. */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const g = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  return g;
}
