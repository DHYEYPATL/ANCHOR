import { describe, expect, it } from 'vitest';
import { MAX_RELAY_RESPONSE_BYTES, readBoundedJson, RELAY_PAGE_SIZE } from './sync';

describe('bounded relay response parsing', () => {
  it('documents a small cursor page size and bounded memory budget', () => {
    expect(RELAY_PAGE_SIZE).toBe(10);
    expect(MAX_RELAY_RESPONSE_BYTES).toBe(16 * 1024 * 1024);
  });

  it('parses a normal JSON response', async () => {
    const response = new Response(JSON.stringify({ changes: [], next_cursor: 4, has_more: false }));
    await expect(readBoundedJson(response)).resolves.toEqual({ changes: [], next_cursor: 4, has_more: false });
  });

  it('rejects an oversized declared body before parsing it', async () => {
    const response = new Response('{}', { headers: { 'Content-Length': '1000' } });
    await expect(readBoundedJson(response, 16)).rejects.toThrow(/exceeds the safety limit/i);
  });

  it('rejects a streamed body that has no trustworthy Content-Length', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"payload":"1234567890"}'));
        controller.close();
      },
    });
    const response = new Response(body);
    await expect(readBoundedJson(response, 8)).rejects.toThrow(/exceeds the safety limit/i);
  });

  it('rejects malformed UTF-8/JSON instead of returning a partial object', async () => {
    const response = new Response('{broken');
    await expect(readBoundedJson(response)).rejects.toThrow(/malformed JSON/i);
  });
});
