import type { IPty } from "bun-pty"
import { Shell } from "@/shell/shell"

const LIMIT = 256 * 1024

type Session = {
  proc: IPty
  buffer: string
  alive: boolean
  pipe: ((chunk: string) => void) | undefined
  detach: (() => void) | undefined
}

const cache = new Map<string, Session>()
let spawn: typeof import("bun-pty")["spawn"] | undefined

async function ensure(id: string, cwd: string) {
  const existing = cache.get(id)
  if (existing?.alive) return existing
  if (existing) cache.delete(id)

  if (!spawn) spawn = (await import("bun-pty")).spawn
  const shell = Shell.preferred()
  const args: string[] = []
  if (shell.endsWith("sh")) args.push("-l")

  const proc = spawn(shell, args, {
    name: "xterm-256color",
    cwd,
    env: { ...process.env, TERM: "xterm-256color", OPENCODE_TERMINAL: "1" },
  })

  const session: Session = {
    proc,
    buffer: "",
    alive: true,
    pipe: undefined,
    detach: undefined,
  }

  proc.onData((chunk: string) => {
    session.buffer += chunk
    if (session.buffer.length > LIMIT) session.buffer = session.buffer.slice(session.buffer.length - LIMIT)
    session.pipe?.(chunk)
  })

  proc.onExit(() => {
    session.alive = false
    session.detach?.()
  })

  cache.set(id, session)
  return session
}

type RGB = [number, number, number]

function ansi(fg: RGB, bg: RGB) {
  return `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m`
}

function statusbar(cols: number, rows: number, label: string, dir: string, fg: RGB, bg: RGB) {
  const left = ` ${label} to return`
  const right = ` ${dir} `
  const gap = Math.max(0, cols - left.length - right.length)
  const style = ansi(fg, bg)
  // Save cursor → re-apply scroll region (guards against resets from shell output
  // or full-screen programs) → move to last row → theme colors → content → reset → restore cursor
  return `\x1b7\x1b[1;${rows - 1}r\x1b[${rows};1H${style}${left}${" ".repeat(gap)}${right}\x1b[0m\x1b8`
}

export namespace PtyAttach {
  export async function open(
    id: string,
    cwd: string,
    renderer: {
      suspend(): void
      resume(): void
      currentRenderBuffer: { clear(): void }
      requestRender(): void
    },
    opts: {
      leader: number
      label: string
      dir: string
      fg: RGB
      bg: RGB
    },
  ) {
    const session = await ensure(id, cwd)
    if (!session.alive) return

    return new Promise<void>((resolve) => {
      renderer.suspend()

      const cols = process.stdout.columns
      const rows = process.stdout.rows

      // Reset attributes
      process.stdout.write("\x1b[0m")

      // Replay buffer to restore visual state
      if (session.buffer) process.stdout.write(session.buffer)

      // Set scroll region to reserve bottom row for status bar.
      // Must be applied after buffer replay: the buffer may contain \x1b[r
      // (reset scroll region) emitted by full-screen programs (vim, less, etc.)
      // on exit, which would otherwise leave the scroll region as full-screen
      // and cause the statusbar to ghost-scroll on every new output line.
      process.stdout.write(`\x1b[1;${rows - 1}r`)

      // Resize PTY to fit within scroll region and draw status bar
      session.proc.resize(cols, rows - 1)
      process.stdout.write(statusbar(cols, rows, opts.label, opts.dir, opts.fg, opts.bg))

      process.stdin.setRawMode(true)
      process.stdin.resume()

      session.pipe = (chunk) => {
        process.stdout.write(chunk)
        // Redraw status bar after each output chunk in case the shell
        // clobbered it (e.g. cursor repositioning, full-screen programs)
        process.stdout.write(statusbar(process.stdout.columns, process.stdout.rows, opts.label, opts.dir, opts.fg, opts.bg))
      }

      // Detect leader key followed by bare Escape to detach.
      // Uses the user's configured leader key (e.g. ctrl+x, ctrl+g).
      // In raw mode, bare Escape arrives as a single 0x1B byte while
      // escape sequences (arrows etc.) arrive as multi-byte events.
      let active = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const handler = (data: Buffer) => {
        // Leader key press (single byte matching the configured leader)
        if (data.length === 1 && data[0] === opts.leader) {
          if (active) {
            // Double leader press — forward one to the shell
            clearTimeout(timer)
            active = false
            session.proc.write(String.fromCharCode(opts.leader))
            return
          }
          active = true
          timer = setTimeout(() => {
            active = false
            // Timed out — forward leader byte to the shell
            session.proc.write(String.fromCharCode(opts.leader))
          }, 2000)
          return
        }

        if (active) {
          clearTimeout(timer)
          active = false

          // Bare Escape (single 0x1B byte) → detach
          if (data.length === 1 && data[0] === 0x1b) {
            done()
            return
          }

          // Not escape — forward the buffered leader byte + this keystroke
          session.proc.write(String.fromCharCode(opts.leader))
          session.proc.write(data.toString())
          return
        }

        // Normal input — forward to shell
        session.proc.write(data.toString())
      }
      process.stdin.on("data", handler)

      const resize = () => {
        const c = process.stdout.columns
        const r = process.stdout.rows
        process.stdout.write(`\x1b[1;${r - 1}r`)
        session.proc.resize(c, r - 1)
        process.stdout.write(statusbar(c, r, opts.label, opts.dir, opts.fg, opts.bg))
      }
      process.stdout.on("resize", resize)

      session.detach = done

      function done() {
        if (timer) clearTimeout(timer)
        active = false
        session.pipe = undefined
        session.detach = undefined
        process.stdin.removeListener("data", handler)
        process.stdout.removeListener("resize", resize)
        process.stdin.setRawMode(false)
        // Reset scroll region to full screen before resuming TUI
        process.stdout.write("\x1b[r")
        renderer.resume()
        renderer.currentRenderBuffer.clear()
        renderer.requestRender()
        resolve()
      }
    })
  }

  export function cleanup() {
    for (const session of cache.values()) {
      if (session.alive) try { session.proc.kill() } catch {}
    }
    cache.clear()
  }
}
