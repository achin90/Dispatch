/// <reference path="./modules.d.ts" />
import { spawn, type ChildProcess } from "child_process"
import { existsSync } from "fs"
import { mkdir, unlink, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import type { KeywordSpotter, OfflineRecognizer, Vad } from "sherpa-onnx-node"

export type STT = ReturnType<typeof createSTT>

export type STTOptions = {
  /** Decode failures — console output is invisible under the TUI. */
  onError?: (message: string) => void
  /** The VAD closed a segment and decoding is starting. */
  onSpeechEnd?: () => void
  /** Decoding finished, whether or not it produced any text. */
  onIdle?: () => void
}

/** Silero requires exactly this many samples per acceptWaveform call. */
const VAD_WINDOW = 512

export function createSTT(options: STTOptions = {}) {
  const onError = options.onError
  let recognizer: OfflineRecognizer | undefined
  let vad: Vad | undefined
  let kwsSpotter: KeywordSpotter | undefined
  let kwsStream: ReturnType<KeywordSpotter["createStream"]> | undefined
  let micHandle: ChildProcess | undefined
  let isRunning = false
  let lastError: string | undefined
  /** Hold count, not a flag: the ding and the TTS gate can overlap. */
  let muteHolds = 0
  let decoding = false
  let processTimer: ReturnType<typeof setInterval> | undefined
  const queue: Float32Array[] = []
  const segments: Float32Array[] = []
  const handlers = new Set<(text: string) => void>()
  const interruptHandlers = new Set<() => void>()
  /** Samples left over from the last drain that didn't fill a VAD window. */
  let carry = new Float32Array(0)

  // Runs off the audio thread: slices captured audio into exact VAD windows,
  // and hands each detected speech segment to the recognizer.
  //
  // This model is offline (batch), not streaming: it transcribes a complete
  // utterance with full context rather than committing to each word as it
  // arrives, which is what makes it accurate enough to be usable. That means
  // the VAD is what decides where an utterance ends — there is no endpointing
  // inside the recognizer to fall back on.
  function drain() {
    if (!queue.length || !vad) return
    const pending = queue.splice(0, queue.length)

    // The keyword spotter stays hot even while muted: it runs on the same
    // audio stream but only detects "jarvis", so Jarvis can be interrupted
    // mid-speech without opening the full transcription pipeline.
    if (kwsSpotter && kwsStream) {
      try {
        for (const chunk of pending) kwsStream.acceptWaveform({ sampleRate: 16000, samples: chunk })
        while (kwsSpotter.isReady(kwsStream)) {
          kwsSpotter.decode(kwsStream)
          if (!kwsSpotter.getResult(kwsStream).keyword) continue
          kwsSpotter.reset(kwsStream)
          for (const handler of interruptHandlers) handler()
        }
      } catch {}
    }

    // Drop audio captured while Jarvis was talking, so it doesn't transcribe
    // its own voice. Discarding here rather than in the capture callback keeps
    // that callback trivial, and closing the mic stream per utterance would
    // add device-open latency to every reply.
    if (muteHolds > 0) return
    try {
      for (const chunk of pending) {
        const combined = carry.length ? concat(carry, chunk) : chunk
        // Feeding anything other than exactly VAD_WINDOW samples makes silero
        // silently never report speech — the bug that made Jarvis look deaf.
        let offset = 0
        while (combined.length - offset >= VAD_WINDOW) {
          vad.acceptWaveform(combined.slice(offset, offset + VAD_WINDOW))
          offset += VAD_WINDOW
        }
        carry = combined.slice(offset)
      }

      const before = segments.length
      while (!vad.isEmpty()) {
        segments.push(vad.front().samples)
        vad.pop()
      }
      if (segments.length > before) options.onSpeechEnd?.()
      if (segments.length) void pump()
    } catch (err) {
      report(err)
    }
  }

  // Transcription is serialized and off the timer: a 0.6B model takes a few
  // hundred milliseconds, and decodeAsync keeps that off the thread rendering
  // the TUI. Overlapping decodes would contend for the same threads and make
  // every utterance slower.
  async function pump() {
    if (decoding || !recognizer) return
    decoding = true
    try {
      while (segments.length) {
        const samples = segments.shift()!
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples })
        await recognizer.decodeAsync(stream)
        const text = String(recognizer.getResult(stream).text ?? "").trim()
        if (text) for (const handler of handlers) handler(text)
      }
    } catch (err) {
      report(err)
    } finally {
      decoding = false
      // Fires even when the decode produced no text, so the indicator can't
      // get stuck showing "thinking" after a segment of noise.
      options.onIdle?.()
    }
  }

  function report(err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // Report once per distinct failure — drain runs every 100ms and a
    // persistent fault would otherwise bury the screen in toasts.
    if (message === lastError) return
    lastError = message
    onError?.(`Speech decode failed: ${message}`)
  }

  /** Resolves to an error message on failure, or undefined on success. Never downloads; see missingModels. */
  async function start() {
    if (isRunning) return
    const missing = missingModels()
    if (missing.length) return `Speech models missing in ${MODELS_DIR}: ${missing.join(", ")}`
    if (!Bun.which("ffmpeg")) return "ffmpeg is not installed; Jarvis captures the microphone with it"

    // Loaded here, not at startup: it is a native addon, and most launches never turn voice on.
    const sherpa = await import("sherpa-onnx-node").then(
      (mod) => ({ mod }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    )
    if ("error" in sherpa) return `sherpa-onnx-node could not load on this platform: ${sherpa.error}`
    const { Vad, OfflineRecognizer, KeywordSpotter } = sherpa.mod

    try {
      const modelDir = path.join(MODELS_DIR, ASR_MODEL_NAME)
      vad = new Vad(
        {
          sileroVad: {
            model: path.join(MODELS_DIR, "silero_vad.onnx"),
            threshold: 0.5,
            minSpeechDuration: 0.25,
            // Short enough to feel responsive, long enough to survive the pause
            // between "Jarvis" and the rest of the command.
            minSilenceDuration: 0.6,
            windowSize: VAD_WINDOW,
          },
          sampleRate: 16000,
          numThreads: 1,
        },
        120,
      )

      recognizer = new OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: `${modelDir}/encoder.int8.onnx`,
            decoder: `${modelDir}/decoder.int8.onnx`,
            joiner: `${modelDir}/joiner.int8.onnx`,
          },
          tokens: `${modelDir}/tokens.txt`,
          // Required: sherpa cannot infer the NeMo transducer variant, and
          // omitting it fails at load time rather than degrading.
          modelType: "nemo_transducer",
          numThreads: 4,
          provider: "cpu",
        },
        decodingMethod: "greedy_search",
      })

      // Keyword spotter: ~3.3M model that stays hot even while the main STT is
      // muted, so "jarvis" can interrupt TTS playback. Only the wake word is
      // used — common words like "stop" trigger on Jarvis's own voice since
      // there's no echo cancellation.
      const kwsDir = path.join(MODELS_DIR, KWS_MODEL_NAME)
      const keywordsFile = path.join(kwsDir, "jarvis-keywords.txt")
      await Bun.write(keywordsFile, "▁JA R VI S @jarvis\n▁JA R V I S @jarvis\n")
      kwsSpotter = new KeywordSpotter({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: `${kwsDir}/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`,
            decoder: `${kwsDir}/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx`,
            joiner: `${kwsDir}/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx`,
          },
          tokens: `${kwsDir}/tokens.txt`,
          numThreads: 1,
          provider: "cpu",
        },
        maxActivePaths: 4,
        keywordsScore: 2.0,
        keywordsThreshold: 0.15,
        keywordsFile,
      })
      kwsStream = kwsSpotter.createStream()
    } catch (err) {
      // Returned rather than only logged: the TUI owns the screen, so anything
      // written to console here is invisible. Swallowing this is what made a
      // dead microphone look like a working one that just never heard speech.
      return err instanceof Error ? err.message : String(err)
    }

    // ffmpeg rather than a native capture module: on macOS AVFoundation always
    // sees the current default input, including Bluetooth devices that appear
    // after the process starts. Output is raw s16le mono at 16kHz, sherpa's
    // native rate, so no resampler is needed.
    const proc = spawn(
      "ffmpeg",
      [
        "-f",
        process.platform === "darwin" ? "avfoundation" : "pulse",
        "-i",
        process.platform === "darwin" ? ":default" : "default",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-loglevel",
        "error",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    micHandle = proc
    proc.on("error", (error) => onError?.(`ffmpeg mic: ${error.message}`))
    proc.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim()
      if (message) onError?.(`ffmpeg mic: ${message}`)
    })
    proc.stdout?.on("data", (chunk: Buffer) => {
      // s16le bytes to Float32 samples in [-1, 1].
      const samples = new Float32Array(Math.floor(chunk.length / 2))
      for (let i = 0; i < samples.length; i++) samples[i] = chunk.readInt16LE(i * 2) / 32768
      queue.push(samples)
    })

    processTimer = setInterval(drain, 100)
    isRunning = true
  }

  async function stop() {
    if (processTimer) clearInterval(processTimer)
    processTimer = undefined
    micHandle?.kill("SIGTERM")
    micHandle = undefined
    queue.length = 0
    segments.length = 0
    carry = new Float32Array(0)
    // Holds don't survive a restart; a mute left over from an interrupted
    // reply would silently make the next session deaf.
    muteHolds = 0
    isRunning = false
  }

  /**
   * While muted, captured audio is discarded instead of transcribed. Reference
   * counted, so overlapping holders can't unmute each other early. The keyword
   * spotter is not affected, so "Jarvis" can still interrupt TTS playback.
   */
  function setMuted(value: boolean) {
    muteHolds = Math.max(0, muteHolds + (value ? 1 : -1))
    // Drop whatever the VAD had half-collected across the gap, so speech from
    // before Jarvis spoke doesn't get stitched onto speech from after it.
    if (muteHolds > 0 || !vad) return
    vad.reset()
    carry = new Float32Array(0)
  }

  return {
    start,
    stop,
    running: () => isRunning,
    setMuted,
    onUtterance(handler: (text: string) => void) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    /** Fires when the keyword spotter detects "jarvis" — even while the main STT is muted. */
    onInterrupt(handler: () => void) {
      interruptHandlers.add(handler)
      return () => interruptHandlers.delete(handler)
    },
    dispose() {
      void stop()
      handlers.clear()
      interruptHandlers.clear()
      recognizer = undefined
      vad = undefined
      kwsSpotter = undefined
      kwsStream = undefined
    },
  }
}

function concat(a: Float32Array, b: Float32Array) {
  const combined = new Float32Array(a.length + b.length)
  combined.set(a)
  combined.set(b, a.length)
  return combined
}

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
const ASR_MODEL_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
const KWS_MODEL_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
export const MODELS_DIR = path.join(os.homedir(), ".jarvis", "models")

const MODELS = [
  {
    name: "voice activity detector",
    present: path.join(MODELS_DIR, "silero_vad.onnx"),
    url: `${RELEASES}/asr-models/silero_vad.onnx`,
  },
  {
    name: "speech recognizer (~600MB)",
    present: path.join(MODELS_DIR, ASR_MODEL_NAME, "tokens.txt"),
    url: `${RELEASES}/asr-models/${ASR_MODEL_NAME}.tar.bz2`,
  },
  {
    name: "wake word spotter",
    present: path.join(MODELS_DIR, KWS_MODEL_NAME, "tokens.txt"),
    url: `${RELEASES}/kws-models/${KWS_MODEL_NAME}.tar.bz2`,
  },
]

/** Names of the speech models not yet under MODELS_DIR. */
export function missingModels() {
  return MODELS.filter((model) => !existsSync(model.present)).map((model) => model.name)
}

/** Downloads whatever missingModels reports. Only on an explicit user confirmation: it is about 600MB. */
export async function downloadModels() {
  await mkdir(MODELS_DIR, { recursive: true })
  for (const model of MODELS.filter((item) => !existsSync(item.present))) {
    const response = await fetch(model.url)
    if (!response.ok) throw new Error(`Failed to download the ${model.name}: HTTP ${response.status}`)
    if (!model.url.endsWith(".tar.bz2")) {
      await writeFile(model.present, Buffer.from(await response.arrayBuffer()))
      continue
    }
    const archive = path.join(MODELS_DIR, path.basename(model.url))
    await writeFile(archive, Buffer.from(await response.arrayBuffer()))
    const tar = Bun.spawn(["tar", "-xjf", archive, "-C", MODELS_DIR])
    const code = await tar.exited
    await unlink(archive)
    if (code !== 0) throw new Error(`Failed to unpack the ${model.name}`)
  }
}
