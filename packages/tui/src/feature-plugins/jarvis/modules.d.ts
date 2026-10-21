// sherpa-onnx-node ships no types. Only the surface Jarvis calls is declared.
declare module "sherpa-onnx-node" {
  type Waveform = { readonly sampleRate: number; readonly samples: Float32Array }

  export class Vad {
    constructor(config: Record<string, unknown>, bufferSizeInSeconds: number)
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    front(): { readonly samples: Float32Array }
    pop(): void
    reset(): void
  }

  interface Stream {
    acceptWaveform(input: Waveform): void
  }

  export class OfflineRecognizer {
    constructor(config: Record<string, unknown>)
    createStream(): Stream
    decodeAsync(stream: Stream): Promise<unknown>
    getResult(stream: Stream): { readonly text?: string }
  }

  export class KeywordSpotter {
    constructor(config: Record<string, unknown>)
    createStream(): Stream
    isReady(stream: Stream): boolean
    decode(stream: Stream): void
    getResult(stream: Stream): { readonly keyword?: string }
    reset(stream: Stream): void
  }
}
