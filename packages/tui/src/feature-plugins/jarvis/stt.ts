export type STT = {
  /** Resolves to an error message on failure, or undefined on success. */
  start: () => Promise<string | undefined>
  stop: () => Promise<void>
  running: () => boolean
  /**
   * While muted, captured audio is discarded instead of transcribed.
   * Reference counted, so overlapping holders can't unmute each other early.
   * The keyword spotter is NOT affected — it stays hot so "stop" and "Jarvis"
   * can interrupt TTS playback.
   */
  setMuted: (muted: boolean) => void
  onUtterance: (handler: (text: string) => void) => () => void
  /** Fires when the keyword spotter detects "jarvis" — even while the main STT is muted. */
  onInterrupt: (handler: () => void) => () => void
  dispose: () => void
}

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

export function createSTT(options: STTOptions = {}): STT {
  const onError = options.onError
  let recognizer: any
  let vad: any
  let kwsSpotter: any
  let kwsStream: any
  let micHandle: any
  let isRunning = false
  let lastError: string | undefined
  /** Hold count, not a flag: the ding and the TTS gate can overlap. */
  let muteHolds = 0
  let decoding = false
  let processTimer: ReturnType<typeof setInterval> | undefined
  const queue: Float32Array[] = []
  const segments: Float32Array[] = []
  const handlers: Set<(text: string) => void> = new Set()
  const interruptHandlers: Set<() => void> = new Set()
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
    if (!queue.length) return
    const pending = queue.splice(0, queue.length)

    // The keyword spotter stays hot even while muted: it runs on the same
    // audio stream but only detects "stop" and "jarvis", so Jarvis can be
    // interrupted mid-speech without opening the full transcription pipeline.
    if (kwsSpotter && kwsStream) {
      try {
        for (const chunk of pending) {
          kwsStream.acceptWaveform({ sampleRate: 16000, samples: chunk })
        }
        while (kwsSpotter.isReady(kwsStream)) {
          kwsSpotter.decode(kwsStream)
          const r = kwsSpotter.getResult(kwsStream)
          if (r.keyword) {
            kwsSpotter.reset(kwsStream)
            for (const handler of interruptHandlers) handler()
          }
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
        let combined = chunk
        if (carry.length) {
          combined = new Float32Array(carry.length + chunk.length)
          combined.set(carry)
          combined.set(chunk, carry.length)
        }
        // Feeding anything other than exactly VAD_WINDOW samples makes silero
        // silently never report speech — the bug that made Jarvis look deaf.
        let offset = 0
        while (combined.length - offset >= VAD_WINDOW) {
          vad.acceptWaveform(combined.slice(offset, offset + VAD_WINDOW))
          offset += VAD_WINDOW
        }
        carry = combined.slice(offset)
      }

      let captured = false
      while (!vad.isEmpty()) {
        segments.push(vad.front().samples)
        vad.pop()
        captured = true
      }
      if (captured) options.onSpeechEnd?.()
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
    if (decoding) return
    decoding = true
    try {
      while (segments.length) {
        const samples = segments.shift()!
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: 16000, samples })
        await recognizer.decodeAsync(stream)
        const text = String(recognizer.getResult(stream).text ?? "").trim()
        if (text) emit(text)
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

  function onUtterance(handler: (text: string) => void) {
    handlers.add(handler)
    return () => handlers.delete(handler)
  }

  function onInterrupt(handler: () => void) {
    interruptHandlers.add(handler)
    return () => interruptHandlers.delete(handler)
  }

  function emit(text: string) {
    for (const handler of handlers) handler(text)
  }

  async function start() {
    if (isRunning) return

    try {
      await ensureModels()
      const sherpa = await import("sherpa-onnx-node")

      const modelsDir = await resolveModelsDir()
      const modelDir = `${modelsDir}/${ASR_MODEL_NAME}`

      vad = new sherpa.Vad(
        {
          sileroVad: {
            model: `${modelsDir}/silero_vad.onnx`,
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

      recognizer = new sherpa.OfflineRecognizer({
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
      const kwsDir = `${modelsDir}/${KWS_MODEL_NAME}`
      const kwsKeywordsFile = `${kwsDir}/jarvis-keywords.txt`
      const fs = await import("fs")
      fs.writeFileSync(
        kwsKeywordsFile,
        "▁JA R VI S @jarvis\n▁JA R V I S @jarvis\n",
      )
      kwsSpotter = new sherpa.KeywordSpotter({
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
        keywordsFile: kwsKeywordsFile,
      })
      kwsStream = kwsSpotter.createStream()

      // Use ffmpeg for mic capture instead of node-cpal. ffmpeg uses macOS
      // AVFoundation which always sees the current default input including
      // Bluetooth devices — node-cpal misses them because cpal only enumerates
      // CoreAudio devices visible at process start.
      //
      // Output: raw signed 16-bit LE, mono, 16kHz — already at sherpa's native
      // rate so no resampler needed.
      const { spawn } = await import("child_process")
      const ffmpegProc = spawn(
        "ffmpeg",
        [
          "-f", process.platform === "darwin" ? "avfoundation" : "pulse",
          "-i", process.platform === "darwin" ? ":default" : "default",
          "-ac", "1",
          "-ar", "16000",
          "-f", "s16le",
          "-acodec", "pcm_s16le",
          "-loglevel", "error",
          "-",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      )

      // Store as the mic handle so stop() can kill it.
      micHandle = ffmpegProc

      ffmpegProc.stderr?.on("data", (chunk: Buffer) => {
        const msg = chunk.toString().trim()
        if (msg) onError?.(`ffmpeg mic: ${msg}`)
      })

      ffmpegProc.stdout?.on("data", (chunk: Buffer) => {
        try {
          // Convert s16le bytes → Float32Array normalized to [-1, 1]
          const sampleCount = Math.floor(chunk.length / 2)
          const samples = new Float32Array(sampleCount)
          for (let i = 0; i < sampleCount; i++) {
            // readInt16LE returns [-32768, 32767]
            samples[i] = chunk.readInt16LE(i * 2) / 32768
          }
          queue.push(samples)
        } catch {}
      })

      processTimer = setInterval(drain, 100)
      isRunning = true
      return undefined
    } catch (err) {
      // Returned rather than only logged: the TUI owns the screen, so anything
      // written to console here is invisible. Swallowing this is what made a
      // dead microphone look like a working one that just never heard speech.
      isRunning = false
      return err instanceof Error ? err.message : String(err)
    }
  }

  async function stop() {
    if (processTimer) {
      clearInterval(processTimer)
      processTimer = undefined
    }
    if (micHandle) {
      const proc = micHandle
      micHandle = undefined
      try {
        proc.kill("SIGTERM")
      } catch {}
    }
    queue.length = 0
    segments.length = 0
    carry = new Float32Array(0)
    // Holds don't survive a restart; a mute left over from an interrupted
    // reply would silently make the next session deaf.
    muteHolds = 0
    isRunning = false
  }

  function dispose() {
    void stop()
    handlers.clear()
    interruptHandlers.clear()
    recognizer = undefined
    vad = undefined
    kwsSpotter = undefined
    kwsStream = undefined
  }

  function setMuted(value: boolean) {
    muteHolds = Math.max(0, muteHolds + (value ? 1 : -1))
    // Drop whatever the VAD had half-collected across the gap, so speech from
    // before Jarvis spoke doesn't get stitched onto speech from after it.
    if (muteHolds === 0 && vad) {
      try {
        vad.reset()
      } catch {}
      carry = new Float32Array(0)
    }
  }

  return { start, stop, running: () => isRunning, setMuted, onUtterance, onInterrupt, dispose }
}

const MODEL_BASE_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
const ASR_MODEL_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
const VAD_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"
const KWS_MODEL_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
const KWS_MODEL_URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models"

async function resolveModelsDir(): Promise<string> {
  const path = await import("path")
  const os = await import("os")
  return path.join(os.homedir(), ".jarvis", "models")
}

async function ensureModels(): Promise<void> {
  const fs = await import("fs")
  const path = await import("path")

  const modelsDir = await resolveModelsDir()
  const asrDir = path.join(modelsDir, ASR_MODEL_NAME)
  const kwsDir = path.join(modelsDir, KWS_MODEL_NAME)
  const vadPath = path.join(modelsDir, "silero_vad.onnx")

  const asrExists = fs.existsSync(path.join(asrDir, "tokens.txt"))
  const kwsExists = fs.existsSync(path.join(kwsDir, "tokens.txt"))
  const vadExists = fs.existsSync(vadPath)
  if (asrExists && vadExists && kwsExists) return

  fs.mkdirSync(modelsDir, { recursive: true })

  if (!vadExists) {
    const resp = await fetch(VAD_URL)
    if (!resp.ok) throw new Error(`Failed to download VAD model: ${resp.status}`)
    fs.writeFileSync(vadPath, Buffer.from(await resp.arrayBuffer()))
  }

  if (!asrExists) {
    console.log("[jarvis:stt] Downloading ASR model (~600MB, first run only)...")
    const resp = await fetch(`${MODEL_BASE_URL}/${ASR_MODEL_NAME}.tar.bz2`)
    if (!resp.ok) throw new Error(`Failed to download ASR model: ${resp.status}`)
    const tarPath = path.join(modelsDir, `${ASR_MODEL_NAME}.tar.bz2`)
    fs.writeFileSync(tarPath, Buffer.from(await resp.arrayBuffer()))

    const { execSync } = await import("child_process")
    execSync(`tar -xjf "${tarPath}" -C "${modelsDir}"`)
    fs.unlinkSync(tarPath)
  }

  if (!kwsExists) {
    console.log("[jarvis:stt] Downloading keyword spotter model (~5MB)...")
    const resp = await fetch(`${KWS_MODEL_URL}/${KWS_MODEL_NAME}.tar.bz2`)
    if (!resp.ok) throw new Error(`Failed to download KWS model: ${resp.status}`)
    const tarPath = path.join(modelsDir, `${KWS_MODEL_NAME}.tar.bz2`)
    fs.writeFileSync(tarPath, Buffer.from(await resp.arrayBuffer()))

    const { execSync } = await import("child_process")
    execSync(`tar -xjf "${tarPath}" -C "${modelsDir}"`)
    fs.unlinkSync(tarPath)
  }

  console.log("[jarvis:stt] Models ready.")
}
