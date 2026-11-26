/** PageLock protocol v1 constants. Changing any of these changes the protocol version. */
export const PROTOCOL = "PL1";
export const PAGE_REPRESENTATION = "PL1-PAGE";
export const MANIFEST_TYPE = "pagelock-manifest";

/** Height of the reserved footer band added BELOW the original page (points; 72pt = 1 inch). */
export const FOOTER_HEIGHT = 72;

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
