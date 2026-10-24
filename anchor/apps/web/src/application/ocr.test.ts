import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isLocalOcrSupported, extractTextFromImageBlob } from './ocr';

describe('Local OCR Module', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('detects unsupported OCR environment when TextDetector is missing', async () => {
    delete (window as unknown as Record<string, unknown>).TextDetector;
    expect(isLocalOcrSupported()).toBe(false);

    const dummyBlob = new Blob(['test'], { type: 'image/png' });
    await expect(extractTextFromImageBlob(dummyBlob)).rejects.toThrow(/not supported by this browser engine/);
  });

  it('extracts text when TextDetector is available', async () => {
    class MockTextDetector {
      detect = vi.fn().mockResolvedValue([
        { rawValue: 'Invoice #1042', boundingBox: {}, cornerPoints: [] },
        { rawValue: 'Due: 2026-11-01', boundingBox: {}, cornerPoints: [] },
      ]);
    }

    (window as unknown as Record<string, unknown>).TextDetector = MockTextDetector;
    (window as unknown as Record<string, unknown>).createImageBitmap = vi.fn().mockResolvedValue({
      width: 100,
      height: 100,
      close: vi.fn(),
    });

    expect(isLocalOcrSupported()).toBe(true);
    const dummyBlob = new Blob(['test'], { type: 'image/png' });
    const text = await extractTextFromImageBlob(dummyBlob);

    expect(text).toContain('Invoice #1042');
    expect(text).toContain('Due: 2026-11-01');
  });
});
