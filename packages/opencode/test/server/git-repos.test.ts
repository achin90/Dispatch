import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

describe("experimental/git-repos", () => {
  test("returns directories that contain .git", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const repoDir = path.join(dir, "my-repo")
        const plainDir = path.join(dir, "not-a-repo")
        await fs.mkdir(repoDir)
        await fs.mkdir(path.join(repoDir, ".git"))
        await fs.mkdir(plainDir)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const response = await app.request(`/experimental/git-repos?root=${encodeURIComponent(tmp.path)}`)

        expect(response.status).toBe(200)
        const body: string[] = await response.json()
        expect(body).toContain(path.join(tmp.path, "my-repo"))
        expect(body).not.toContain(path.join(tmp.path, "not-a-repo"))
      },
    })
  })

  test("recursively finds nested git repos", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // org/BillingService and org/AppService are repos
        const org = path.join(dir, "VioletServices")
        await fs.mkdir(org)
        for (const name of ["BillingService", "AppService"]) {
          const repo = path.join(org, name)
          await fs.mkdir(repo)
          await fs.mkdir(path.join(repo, ".git"))
        }
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const response = await app.request(`/experimental/git-repos?root=${encodeURIComponent(tmp.path)}`)

        expect(response.status).toBe(200)
        const body: string[] = await response.json()
        expect(body).toHaveLength(2)
        expect(body).toContain(path.join(tmp.path, "VioletServices", "AppService"))
        expect(body).toContain(path.join(tmp.path, "VioletServices", "BillingService"))
      },
    })
  })

  test("prunes at repo root and does not return subdirectories", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // repo with a nested subdir that also has a .git (e.g. submodule)
        const repo = path.join(dir, "my-repo")
        await fs.mkdir(repo)
        await fs.mkdir(path.join(repo, ".git"))
        const sub = path.join(repo, "src", "nested")
        await fs.mkdir(sub, { recursive: true })
        await fs.mkdir(path.join(sub, ".git"))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const response = await app.request(`/experimental/git-repos?root=${encodeURIComponent(tmp.path)}`)

        expect(response.status).toBe(200)
        const body: string[] = await response.json()
        expect(body).toEqual([path.join(tmp.path, "my-repo")])
      },
    })
  })

  test("skips node_modules directories", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const nm = path.join(dir, "node_modules", "some-pkg")
        await fs.mkdir(nm, { recursive: true })
        await fs.mkdir(path.join(nm, ".git"))
        const repo = path.join(dir, "real-repo")
        await fs.mkdir(repo)
        await fs.mkdir(path.join(repo, ".git"))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const response = await app.request(`/experimental/git-repos?root=${encodeURIComponent(tmp.path)}`)

        expect(response.status).toBe(200)
        const body: string[] = await response.json()
        expect(body).toEqual([path.join(tmp.path, "real-repo")])
      },
    })
  })

  test("filters repos by query param", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const alpha = path.join(dir, "alpha-project")
        const beta = path.join(dir, "beta-project")
        await fs.mkdir(alpha)
        await fs.mkdir(path.join(alpha, ".git"))
        await fs.mkdir(beta)
        await fs.mkdir(path.join(beta, ".git"))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const response = await app.request(`/experimental/git-repos?root=${encodeURIComponent(tmp.path)}&query=alpha`)

        expect(response.status).toBe(200)
        const body: string[] = await response.json()
        expect(body).toHaveLength(1)
        expect(body[0]).toContain("alpha-project")
      },
    })
  })

  test("returns empty array for non-existent root", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const response = await app.request(
          `/experimental/git-repos?root=${encodeURIComponent("/tmp/nonexistent-dir-" + Date.now())}`,
        )

        expect(response.status).toBe(200)
        const body: string[] = await response.json()
        expect(body).toEqual([])
      },
    })
  })

  test("excludes hidden directories", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const hidden = path.join(dir, ".hidden-repo")
        const visible = path.join(dir, "visible-repo")
        await fs.mkdir(hidden)
        await fs.mkdir(path.join(hidden, ".git"))
        await fs.mkdir(visible)
        await fs.mkdir(path.join(visible, ".git"))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const response = await app.request(`/experimental/git-repos?root=${encodeURIComponent(tmp.path)}`)

        expect(response.status).toBe(200)
        const body: string[] = await response.json()
        expect(body).toHaveLength(1)
        expect(body[0]).toContain("visible-repo")
      },
    })
  })

  test("returns results sorted alphabetically", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        for (const name of ["charlie", "alpha", "bravo"]) {
          const d = path.join(dir, name)
          await fs.mkdir(d)
          await fs.mkdir(path.join(d, ".git"))
        }
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const response = await app.request(`/experimental/git-repos?root=${encodeURIComponent(tmp.path)}`)

        expect(response.status).toBe(200)
        const body: string[] = await response.json()
        expect(body).toHaveLength(3)
        expect(body[0]).toContain("alpha")
        expect(body[1]).toContain("bravo")
        expect(body[2]).toContain("charlie")
      },
    })
  })
})
