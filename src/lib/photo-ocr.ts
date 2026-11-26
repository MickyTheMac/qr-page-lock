/**
 * Reads the words in a picture, on this device. Uses Tesseract (open source), loaded from PageLock's own site,
 * so the picture never leaves the device. The first use downloads about 7 MB; after that the browser keeps it.
 */
import { LooksCheck, RgbImage, judgeLooks, rgbToRgba } from "@/lib/pagelock";

type Worker = { recognize(img: HTMLCanvasElement): Promise<{ data: { text: string } }>; setParameters(p: Record<string, string>): Promise<unknown> };
let worker: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  worker ??= (async () => {
    const T = await import("tesseract.js");
    const w = await T.createWorker("eng", 1, {
      workerPath: "/tesseract/worker.min.js",
      corePath: "/tesseract",
      langPath: "/tesseract",
      gzip: true,
      workerBlobURL: false,
    });
    await w.setParameters({ tessedit_pageseg_mode: T.PSM.SPARSE_TEXT });
    return w as unknown as Worker;
  })();
  worker.catch(() => (worker = null));
  return worker;
}

/** Starts the download early (e.g. when the camera starts) so the check is quick when the picture is taken. */
export function warmUpReader() {
  getWorker().catch(() => undefined);
}

export async function readWords(img: RgbImage): Promise<string> {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")!.putImageData(new ImageData(rgbToRgba(img), img.width, img.height), 0, 0);
  const w = await getWorker();
  const { data } = await w.recognize(c);
  return data.text;
}

/** Null if the check could not run (for example, the reader could not be downloaded). */
export async function checkLooks(expected: string, img: RgbImage): Promise<LooksCheck | null> {
  if (expected === "Other") return judgeLooks(expected, "");
  try {
    return judgeLooks(expected, await readWords(img));
  } catch {
    return null;
  }
}
