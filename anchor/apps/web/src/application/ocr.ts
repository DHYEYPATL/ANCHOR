/**
 * Local OCR (Optical Character Recognition) module.
 * Runs strictly on-device using the browser's native Shape Detection API (TextDetector)
 * and Canvas rendering for scanned PDFs and image attachments.
 * Never sends image bytes or extracted text to cloud services.
 */

export interface DetectedText {
  boundingBox: DOMRectReadOnly;
  rawValue: string;
  cornerPoints: Array<{ x: number; y: number }>;
}

export interface NativeTextDetector {
  detect(image: ImageBitmapSource): Promise<DetectedText[]>;
}

declare global {
  interface Window {
    TextDetector?: new () => NativeTextDetector;
  }
}

export function isLocalOcrSupported(): boolean {
  return typeof window !== 'undefined' && 'TextDetector' in window;
}

/**
 * Extracts visible text from an image Blob or File using local on-device OCR.
 */
export async function extractTextFromImageBlob(blob: Blob): Promise<string> {
  if (!isLocalOcrSupported()) {
    throw new Error('On-device OCR is not supported by this browser engine (Shape Detection API). You can use a local Ollama vision model or enter a manual description.');
  }

  const detector = new window.TextDetector!();
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const results = await detector.detect(bitmap);
    return results.map((r) => r.rawValue.trim()).filter(Boolean).join('\n');
  } finally {
    bitmap?.close();
  }
}

/**
 * Renders pages of a scanned PDF to canvas and extracts text using on-device OCR.
 */
export async function extractOcrFromPdf(
  file: File,
  maxPages = 5,
): Promise<{ text: string; pagesProcessed: number }> {
  if (!isLocalOcrSupported()) {
    throw new Error('On-device OCR is not supported in this browser. Keep the PDF as an encrypted attachment or transcribe key details.');
  }

  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: false });
  const detector = new window.TextDetector!();

  try {
    const pdf = await loadingTask.promise;
    const pageLimit = Math.min(pdf.numPages, maxPages);
    const textPieces: string[] = [];

    for (let pageNum = 1; pageNum <= pageLimit; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      try {
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        // Render PDF page to canvas
        // @ts-expect-error PDF.js render options
        await page.render({ canvasContext: ctx, viewport }).promise;

        const results = await detector.detect(canvas);
        const pageText = results.map((r) => r.rawValue.trim()).filter(Boolean).join(' ');
        if (pageText) {
          textPieces.push(`Page ${pageNum} (OCR): ${pageText}`);
        }
      } finally {
        page.cleanup();
      }
    }

    return {
      text: textPieces.join('\n\n'),
      pagesProcessed: pageLimit,
    };
  } finally {
    bytes.fill(0);
    await loadingTask.destroy();
  }
}
