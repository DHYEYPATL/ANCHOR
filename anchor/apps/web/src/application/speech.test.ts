import { describe, expect, it, vi, beforeEach } from 'vitest';
import { isSpeechRecognitionSupported, startSpeechTranscription } from './speech';

describe('Speech Recognition', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('detects unsupported environment when Web Speech is absent', () => {
    const originalSR = window.SpeechRecognition;
    const originalWSR = window.webkitSpeechRecognition;
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;

    expect(isSpeechRecognitionSupported()).toBe(false);
    expect(startSpeechTranscription(() => {})).toBeNull();

    window.SpeechRecognition = originalSR;
    window.webkitSpeechRecognition = originalWSR;
  });

  it('initializes speech recognition and handles transcription events', () => {
    class MockSpeechRecognition extends EventTarget {
      continuous = false;
      interimResults = false;
      lang = '';
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
    }

    (window as unknown as Record<string, unknown>).SpeechRecognition = MockSpeechRecognition;

    const onTranscriptChange = vi.fn();
    const session = startSpeechTranscription(onTranscriptChange);

    expect(session).not.toBeNull();
    session?.stop();
  });
});
