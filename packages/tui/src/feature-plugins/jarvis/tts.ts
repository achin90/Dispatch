import { spawn, type ChildProcess } from "child_process"
import { tmpdir } from "os"
import { join } from "path"

export type TTS = {
  speak: (text: string) => Promise<void>
  stop: () => void
  ready: () => boolean
  init: () => Promise<void>
  dispose: () => void
}

// How long to wait for the sidecar to download/load the model on first run.
const READY_TIMEOUT = 120_000
const SYNTH_TIMEOUT = 30_000
// Just enough to cover room echo of the last syllable. Anything longer is dead
// air before you can speak, and the caller's "ready" chime holds the mic past
// this anyway — stacking two full-length delays is what made replies feel slow.
const SPEAKING_TAIL_MS = 120
/**
 * Kokoro-82M has a 510-token phoneme context and silently drops everything
 * past it — roughly three sentences — so long answers must be split and
 * synthesized in pieces. Characters are a rough proxy for phonemes; this is
 * set well under the limit so an unusually dense sentence still fits.
 */
const MAX_CHUNK_CHARS = 280

/**
 * Strip markup that a text-to-speech model reads out literally — "asterisk
 * asterisk" for bold, backticks, pipe characters in tables. Agent output is
 * written for a screen even when it's headed for a speaker.
 */
export function speakable(text: string): string {
  return (
    text
      // Fenced code blocks: reading source aloud is never useful.
      .replace(/```[\s\S]*?```/g, " code block. ")
      .replace(/`([^`]+)`/g, "$1")
      // Images before links — the link pattern would otherwise eat the alt text.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, " ")
      .replace(/^\s*[-*+]\s+/gm, "")
      // Emphasis: handle the paired forms, then any leftover runs. Bare "*"
      // and "_" are stripped rather than spoken.
      .replace(/(\*\*\*|___)(\S[\s\S]*?\S|\S)\1/g, "$2")
      .replace(/(\*\*|__)(\S[\s\S]*?\S|\S)\1/g, "$2")
      // Word-boundary guarded, matching CommonMark: intra-word markers are not
      // emphasis, so the identifier "a_b_c" survives instead of becoming "abc".
      .replace(/(?<![\w*_])(\*|_)(\S[\s\S]*?\S|\S)\1(?![\w*_])/g, "$2")
      // Leftover unpaired markers, but only where they hug a word on exactly
      // one side. A blanket strip would turn "5 * 3" into "5 3" and the
      // identifier "a_b_c" into "abc".
      .replace(/(^|\s)[*_]+(?=\S)/g, "$1")
      .replace(/(\S)[*_]+(?=\s|$)/g, "$1")
      // Table separator rows are pure punctuation and read as a run of dashes.
      .replace(/^[ \t]*[|:\-  \t]{3,}$/gm, "")
      // Table pipes read as "pipe"; the cell text on its own is still useful.
      .replace(/^\s*\|(.+)\|\s*$/gm, "$1")
      .replace(/\s*\|\s*/g, ", ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim()
  )
}

/** Split on sentence boundaries, packing as much as fits into each chunk. */
function splitForSynthesis(text: string): string[] {
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [text]
  const chunks: string[] = []
  let current = ""

  for (const raw of sentences) {
    const sentence = raw.trim()
    if (!sentence) continue

    if (sentence.length > MAX_CHUNK_CHARS) {
      if (current) {
        chunks.push(current)
        current = ""
      }
      // A single sentence over the limit still has to be broken up, so fall
      // back to word boundaries rather than cutting mid-word.
      let remainder = sentence
      while (remainder.length > MAX_CHUNK_CHARS) {
        const window = remainder.slice(0, MAX_CHUNK_CHARS)
        const cut = window.lastIndexOf(" ")
        const take = cut > 0 ? cut : MAX_CHUNK_CHARS
        chunks.push(remainder.slice(0, take).trim())
        remainder = remainder.slice(take).trim()
      }
      current = remainder
      continue
    }

    if (!current) current = sentence
    else if (current.length + 1 + sentence.length <= MAX_CHUNK_CHARS) current += " " + sentence
    else {
      chunks.push(current)
      current = sentence
    }
  }

  if (current) chunks.push(current)
  return chunks.length ? chunks : [text]
}

/**
 * Kokoro synthesis runs in its own process: `kokoro-js` pulls in an
 * Emscripten/WASM runtime via `phonemizer` that we don't want loaded into the
 * TUI, and synthesis is CPU-heavy enough to stall the render loop.
 *
 * The source is embedded rather than shipped as a file so it needs no asset
 * plumbing through the bundler. It is run with `bun -e`, whose bare-specifier
 * resolution follows cwd — hence the cwd below.
 *
 * Protocol: one JSON request per line on stdin, one JSON reply per line on
 * stdout.
 *   -> {"id":1,"text":"hello","out":"/tmp/x.wav"}
 *   <- {"id":1,"ok":true}  |  {"id":1,"ok":false,"error":"..."}
 */
const WORKER_SOURCE = `
const { KokoroTTS } = await import("kokoro-js")
const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
  dtype: "q8",
  device: "cpu",
})
console.log(JSON.stringify({ ready: true }))
for await (const line of console) {
  const text = line.trim()
  if (!text) continue
  let request
  try { request = JSON.parse(text) } catch { continue }
  try {
    const audio = await tts.generate(request.text, {
      voice: process.env.JARVIS_VOICE || "af_heart",
      speed: Number(process.env.JARVIS_TTS_SPEED) || 1.25,
    })
    await audio.save(request.out)
    console.log(JSON.stringify({ id: request.id, ok: true }))
  } catch (error) {
    console.log(JSON.stringify({ id: request.id, ok: false, error: String(error) }))
  }
}
`

/**
 * @param onSpeaking Called with `true` when Jarvis starts talking and `false`
 * shortly after it stops, so the caller can gate microphone capture and keep
 * Jarvis from transcribing itself.
 */
export function createTTS(onSpeaking?: (speaking: boolean) => void): TTS {
  let worker: ChildProcess | undefined
  let player: ChildProcess | undefined
  let workerReady = false
  let nextID = 1
  let speaking = 0
  let speakingTail: ReturnType<typeof setTimeout> | undefined
  /** Bumped per speak() so a superseded multi-chunk read stops queueing audio. */
  let speakToken = 0
  const pending = new Map<number, (result: { ok: boolean; error?: string }) => void>()

  async function init() {
    if (worker) return

    const child = spawn("bun", ["-e", WORKER_SOURCE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd: import.meta.dir,
    })
    worker = child

    let buffer = ""
    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString()
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        if (!line) continue

        try {
          const message = JSON.parse(line)
          if (message.ready) {
            workerReady = true
            continue
          }
          pending.get(message.id)?.({ ok: message.ok, error: message.error })
          pending.delete(message.id)
        } catch {}
      }
    })

    // The sidecar logs model download progress here; surface failures only.
    child.stderr?.on("data", (data: Buffer) => {
      console.debug("[jarvis:tts]", data.toString().trim())
    })

    const reset = () => {
      workerReady = false
      worker = undefined
      for (const resolve of pending.values()) resolve({ ok: false, error: "sidecar exited" })
      pending.clear()
    }
    child.on("exit", reset)
    child.on("error", (error) => {
      console.error("[jarvis:tts] sidecar failed to spawn:", error)
      reset()
    })

    await waitForReady(child)
  }

  function waitForReady(child: ChildProcess) {
    return new Promise<void>((resolve) => {
      if (workerReady) return resolve()
      const started = Date.now()
      const poll = setInterval(() => {
        if (workerReady || child.exitCode !== null || Date.now() - started > READY_TIMEOUT) {
          clearInterval(poll)
          resolve()
        }
      }, 100)
    })
  }

  async function speak(text: string) {
    // Applied here rather than at the call sites so every path — Kokoro and
    // the system-voice fallback — speaks the same cleaned text.
    const trimmed = speakable(text)
    if (!trimmed) return
    stop()
    beginSpeaking()
    try {
      await synthesize(trimmed)
    } finally {
      endSpeaking()
    }
  }

  /**
   * The microphone is always open, including while Jarvis is talking, so
   * without this it transcribes its own output — "Which agent?" comes back as
   * the answer to itself. Callers gate capture on these.
   */
  function beginSpeaking() {
    speaking++
    if (speaking === 1) onSpeaking?.(true)
  }

  function endSpeaking() {
    speaking--
    if (speaking > 0) return
    // Hold the gate briefly: room echo and the recognizer's own trailing
    // silence both arrive after the audio device goes quiet.
    if (speakingTail) clearTimeout(speakingTail)
    speakingTail = setTimeout(() => {
      speakingTail = undefined
      if (speaking === 0) onSpeaking?.(false)
    }, SPEAKING_TAIL_MS)
  }

  async function synthesize(trimmed: string) {
    if (!worker || !workerReady) {
      await speakFallback(trimmed)
      return
    }

    const chunks = splitForSynthesis(trimmed)
    const token = ++speakToken

    // Synthesize one chunk ahead of playback: the next clip renders while the
    // current one plays, so long answers don't stutter between sentences.
    let upcoming: Promise<{ ok: boolean; file?: string; error?: string } | undefined> = render(chunks[0]!)
    for (let i = 0; i < chunks.length; i++) {
      const result = await upcoming
      // A newer speak() superseded this one — stop before queueing more audio.
      if (token !== speakToken) return
      upcoming = i + 1 < chunks.length ? render(chunks[i + 1]!) : Promise.resolve(undefined)

      if (!result?.ok || !result.file) {
        console.debug("[jarvis:tts] synthesis failed, using system voice:", result?.error)
        await speakFallback(chunks[i]!)
      } else {
        await play(result.file)
      }
      if (token !== speakToken) return
    }
  }

  function render(text: string): Promise<{ ok: boolean; file?: string; error?: string }> {
    const id = nextID++
    const out = join(tmpdir(), `jarvis-tts-${id}.wav`)
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        resolve({ ok: false, error: "synthesis timed out" })
      }, SYNTH_TIMEOUT)

      pending.set(id, (value) => {
        clearTimeout(timeout)
        resolve({ ok: value.ok, file: value.ok ? out : undefined, error: value.error })
      })

      worker!.stdin?.write(JSON.stringify({ id, text, out }) + "\n")
    })
  }

  function speakFallback(text: string) {
    if (process.platform === "darwin") return run("say", ["-r", "250", text])
    if (process.platform === "linux") return run("espeak", [text])
    return Promise.resolve()
  }

  function play(file: string) {
    return run(process.platform === "darwin" ? "afplay" : "aplay", [file])
  }

  function run(command: string, args: string[]) {
    return new Promise<void>((resolve) => {
      const child = spawn(command, args)
      player = child
      const done = () => {
        if (player === child) player = undefined
        resolve()
      }
      child.on("close", done)
      child.on("error", done)
    })
  }

  function stop() {
    // Invalidate any in-flight multi-chunk read, otherwise killing the player
    // only silences the current sentence and the next one starts right after.
    speakToken++
    player?.kill()
    player = undefined
  }

  function dispose() {
    stop()
    worker?.kill()
    worker = undefined
    workerReady = false
    pending.clear()
  }

  return { speak, stop, ready: () => workerReady, init, dispose }
}
