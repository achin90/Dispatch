import { execFile } from "child_process"

export interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

export function git(args: string[], opts?: { cwd?: string }): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: opts?.cwd, maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      const exitCode = err ? ((err as { code?: number }).code ?? 1) : 0
      resolve({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "" })
    })
  })
}
