/** PageLock protocol v1 constants. Changing any of these changes the protocol version. */
export const PROTOCOL = "PL1";
export const PAGE_REPRESENTATION = "PL1-PAGE";
export const MANIFEST_TYPE = "pagelock-manifest";

/**
 * Height of the reserved footer band added BELOW the original page (points; 72pt = 1 inch).
 * Layout 3 (current): 82 pt (about 1.14 in), compact two-column text and a smaller QR footprint,
 * with nothing printed in the bottom 0.25 in. Layout 2 was 108 pt, layout 1 was 72 pt.
 */
export const FOOTER_HEIGHT = 82;
/** Every footer layout ever issued, by band height. Layout 1 (1 in) is kept so older sealed PDFs still verify. */
export const FOOTER_LAYOUTS = [72, 108, 82] as const;
/**
 * Nothing is drawn closer than this to the bottom edge of a sealed page (layout 3): 0.25 in (6.35 mm).
 * Most current laser and inkjet printers cannot print only the last 3 to 5 mm, so this clears them.
 * Layout 2 used 0.5 in (fixed inside footerLayout2).
 */
export const PRINT_SAFE_BOTTOM = 18;

/** Names used inside prepared pages. */
export const ORIGINAL_XOBJECT = "PLOrig";
export const FOOTER_XOBJECT = "PLFoot";
export const QR_XOBJECT = "PLQR";
export const FONT_REGULAR = "PLF1";
export const FONT_BOLD = "PLF2";

/** Limits (brief §7: set file size and page count limits). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PAGES = 300;
export const MIN_PAGE_WIDTH = 288; // 4 inches, so the footer fits
export const MAX_PAGE_SIDE = 14400;

export const START = "START";
export const END = "END";

/** Catalog key holding the embedded (untrusted on its own) copy of the manifest body. */
export const MANIFEST_KEY = "PLManifest";

/** Layout 3: QR drawn 56 pt square with no built-in quiet zone (white space around it instead). */
export const QR_SIZE = 56;
/** White border (modules) built into the QR image, per layout. */
export function qrQuietZoneFor(footerHeight: number): number {
  return footerHeight === 82 ? 0 : 4;
}
