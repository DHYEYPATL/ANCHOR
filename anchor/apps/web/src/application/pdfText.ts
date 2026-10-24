/**
 * Local PDF text extraction. PDF.js runs in the browser; no PDF bytes or text are
 * uploaded. Scanned/image-only PDFs yield little or no text and need a separate OCR
 * adapter (not silently sent to a cloud service).
 */
export interface PdfTextResult {
  text: string;
  pagesRead: number;
  totalPages: number;
  truncated: boolean;
}

export async function extractPdfText(file: File, maxPages = 20, maxCharacters = 20_000): Promise<PdfTextResult> {
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('Choose a PDF file.');
  }
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error('PDF must be between 1 byte and 10 MiB.');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('PDF page limit is invalid.');
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 100 || maxCharacters > 20_000) throw new Error('PDF text limit is invalid.');

  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: false });
  try {
    const pdf = await loadingTask.promise;
    const pageLimit = Math.min(pdf.numPages, maxPages);
    const pieces: string[] = [];
    let charCount = 0;
    let truncated = pdf.numPages > pageLimit;
    let pagesRead = 0;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const line = content.items
          .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
          .filter(Boolean).join(' ');
        if (line) {
          const remaining = maxCharacters - charCount;
          if (remaining <= 0) { truncated = true; break; }
          const accepted = line.slice(0, remaining);
          pieces.push(`Page ${pageNumber}: ${accepted}`);
          charCount += accepted.length;
          if (accepted.length < line.length) { truncated = true; break; }
        }
        pagesRead += 1;
      } finally {
        page.cleanup();
      }
    }
    return { text: pieces.join('\n\n'), pagesRead, totalPages: pdf.numPages, truncated };
  } finally {
    bytes.fill(0);
    await loadingTask.destroy();
  }
}
