/** Rejection rules for unsupported, ambiguous or active PDFs (brief §5, §7). */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFRawStream, PDFRef } from "pdf-lib";
import { UnsupportedPdfError } from "./errors";

const ACTIVE_KEYS = new Set(["JS", "JavaScript", "RichMedia", "XFA", "EmbeddedFiles", "EmbeddedFile", "Launch"]);
const ACTIVE_ACTIONS = new Set(["JavaScript", "Launch", "SubmitForm", "ImportData", "ResetForm", "Rendition", "GoToE", "RichMediaExecute", "Sound", "Movie"]);

/** Walks every object (without following references) looking for active content. */
export function findActiveContent(doc: PDFDocument): string | null {
  const visit = (obj: PDFObject, depth: number): string | null => {
    if (depth > 32) return null;
    let dict: PDFDict | undefined;
    if (obj instanceof PDFRawStream) dict = obj.dict;
    else if (obj instanceof PDFDict) dict = obj;
    if (dict) {
      for (const [k, v] of dict.entries()) {
        const key = k.decodeText();
        if (ACTIVE_KEYS.has(key)) return `contains active or embedded content (/${key})`;
        if (key === "S" && v instanceof PDFName && ACTIVE_ACTIONS.has(v.decodeText()))
          return `contains an active action (/${v.decodeText()})`;
        if (key === "Type" && v instanceof PDFName && ["EmbeddedFile", "Filespec"].includes(v.decodeText()))
          return "contains an attached or linked file";
        if (!(v instanceof PDFRef)) {
          const r = visit(v, depth + 1);
          if (r) return r;
        }
      }
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) {
        if (!(v instanceof PDFRef)) {
          const r = visit(v, depth + 1);
          if (r) return r;
        }
      }
    }
    return null;
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const r = visit(obj, 0);
    if (r) return r;
  }
  const cat = doc.catalog;
  for (const key of ["OpenAction", "AA", "AcroForm", "OCProperties", "Collection", "Perms"]) {
    if (cat.get(PDFName.of(key))) {
      const why: Record<string, string> = {
        OpenAction: "runs an action when opened",
        AA: "has automatic actions",
        AcroForm: "contains form fields or signature fields",
        OCProperties: "has hidden/optional layers (ambiguous content)",
        Collection: "is a PDF portfolio",
        Perms: "has permission or signature settings",
      };
      return why[key];
    }
  }
  return null;
}

export function assertBasicFile(bytes: Uint8Array, maxBytes: number) {
  if (bytes.length > maxBytes) throw new UnsupportedPdfError(`File is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new UnsupportedPdfError("This file is not a PDF.");
}

/** Number of saved revisions (each incremental update appends another %%EOF). */
export function countRevisions(bytes: Uint8Array): number {
  const s = new TextDecoder("latin1").decode(bytes);
  return (s.match(/%%EOF/g) ?? []).length;
}

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/encrypt/i.test(msg)) throw new UnsupportedPdfError("This PDF is encrypted or password-protected. Remove protection and try again.");
    throw new UnsupportedPdfError("This PDF could not be read reliably (it may be damaged or use unsupported features).");
  }
}
