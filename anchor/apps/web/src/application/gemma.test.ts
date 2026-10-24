import { describe, expect, it } from 'vitest';
import { LocalGemmaOllamaAdapter, validateLoopbackEndpoint } from './gemma';

describe('local Gemma endpoint safety', () => {
  it('accepts loopback-only Ollama endpoints', () => {
    expect(validateLoopbackEndpoint('http://localhost:11434').origin).toBe('http://localhost:11434');
    expect(new LocalGemmaOllamaAdapter('http://127.0.0.1:11434', 'gemma4:e2b')).toBeTruthy();
  });
  it('rejects remote endpoints before any network request', () => {
    expect(() => new LocalGemmaOllamaAdapter('https://example.com', 'gemma4:e2b')).toThrow(/loopback/i);
    expect(() => validateLoopbackEndpoint('http://192.168.1.5:11434')).toThrow(/loopback/i);
  });
  it('rejects endpoint paths and embedded credentials', () => {
    expect(() => validateLoopbackEndpoint('http://user:pass@localhost:11434')).toThrow(/credentials/i);
    expect(() => validateLoopbackEndpoint('http://localhost:11434/api')).toThrow(/origin/i);
  });
  it('rejects invalid local model tags', () => {
    expect(() => new LocalGemmaOllamaAdapter('http://localhost:11434', '  ')).toThrow(/model tag/i);
  });
});
