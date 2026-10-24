/**
 * Local Speech-to-Text integration using the browser's Web Speech API.
 * Captures spoken voice locally and transcribes it on-device without sending
 * audio data to a hosted transcription cloud service.
 */

export interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResultItem;
  [index: number]: SpeechRecognitionResultItem;
}

export interface SpeechRecognitionResultItem {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

export interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

export interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event & { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

export function isSpeechRecognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export interface SpeechTranscriptionSession {
  stop(): void;
  abort(): void;
}

export function startSpeechTranscription(
  onTranscriptChange: (transcript: string, isFinal: boolean) => void,
  onError?: (error: string) => void,
  onEnd?: () => void,
): SpeechTranscriptionSession | null {
  if (!isSpeechRecognitionSupported()) return null;

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) return null;

  try {
    const recognition = new SpeechRec();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    let accumulatedFinal = '';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const item = event.results[i];
        if (item.isFinal) {
          accumulatedFinal += (accumulatedFinal ? ' ' : '') + item[0].transcript.trim();
        } else {
          interim += item[0].transcript;
        }
      }
      const combined = (accumulatedFinal + (interim ? (accumulatedFinal ? ' ' : '') + interim : '')).trim();
      onTranscriptChange(combined, !interim);
    };

    recognition.onerror = (event) => {
      // Don't surface abort or no-speech as fatal errors.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      onError?.(event.error ? `Speech recognition note: ${event.error}` : 'Speech recognition could not continue.');
    };

    recognition.onend = () => {
      onEnd?.();
    };

    recognition.start();

    return {
      stop: () => {
        try { recognition.stop(); } catch { /* Already stopped */ }
      },
      abort: () => {
        try { recognition.abort(); } catch { /* Already aborted */ }
      },
    };
  } catch (err) {
    onError?.(err instanceof Error ? err.message : 'Could not initialize speech recognition');
    return null;
  }
}
