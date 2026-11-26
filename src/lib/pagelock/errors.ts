/** Thrown when an input PDF is unsupported or ambiguous and must be rejected (brief §5, §7). */
export class UnsupportedPdfError extends Error {
  constructor(message: string, readonly page?: number) {
    super(message);
    this.name = "UnsupportedPdfError";
  }
}
