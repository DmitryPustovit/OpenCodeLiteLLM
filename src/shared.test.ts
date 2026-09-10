import assert from "node:assert/strict"
import { beforeEach, describe, it, mock } from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "@opencode-ai/plugin"
import { getClient } from "./shared.ts"

const configWith = (options: Record<string, unknown>) =>
  ({ provider: { litellm: { options } } }) as unknown as Config

/** Captures the URL the client would request, without going near the network. */
async function urlFor(options: Record<string, unknown>, path: string): Promise<string> {
  const calls: string[] = []
  mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url)
    return new Response("{}")
  })
  const get = getClient(configWith(options), "litellm")
  assert.ok(get, "expected a client")
  await get(path)
  return calls[0]!
}

beforeEach(() => {
  mock.restoreAll()
  delete process.env.LITELLM_BASE_URL
  delete process.env.LITELLM_API_KEY
  // Point the auth.json lookup at a directory that has none, so results never
  // depend on whether the machine running the tests has logged in.
  process.env.XDG_DATA_HOME = join(tmpdir(), "opencode-litellm-tests-no-auth")
})

/** Collects what the client logs while making one request. */
async function errorsFrom(options: Record<string, unknown>, status: number): Promise<string[]> {
  const errors: string[] = []
  mock.method(console, "error", (message: string) => errors.push(message))
  mock.method(globalThis, "fetch", async () => new Response("", { status }))
  const get = getClient(configWith(options), "litellm")
  await get!("/model/info")
  return errors
}

describe("getClient", () => {
  it("appends a route to the baseURL", async () => {
    assert.equal(await urlFor({ baseURL: "https://h/v1" }, "/model/info"), "https://h/v1/model/info")
  })

  it("collapses a trailing slash instead of doubling it", async () => {
    assert.equal(await urlFor({ baseURL: "https://h/v1/" }, "/model/info"), "https://h/v1/model/info")
    assert.equal(await urlFor({ baseURL: "https://h/v1///" }, "/model/info"), "https://h/v1/model/info")
  })

  // LiteLLM mirrors every route we use under both / and /v1, so a baseURL
  // without the suffix opencode wants must still resolve.
  it("works on a baseURL with no /v1 suffix", async () => {
    assert.equal(await urlFor({ baseURL: "https://h" }, "/model/info"), "https://h/model/info")
    assert.equal(await urlFor({ baseURL: "https://h/" }, "/model/info"), "https://h/model/info")
  })

  it("keeps a non-root mount path", async () => {
    assert.equal(await urlFor({ baseURL: "https://h/litellm/v1/" }, "/model/info"), "https://h/litellm/v1/model/info")
  })

  it("leaves slashes inside the path alone", async () => {
    assert.equal(await urlFor({ baseURL: "https://h/v1" }, "/search/searxng"), "https://h/v1/search/searxng")
  })

  it("sends the key as a bearer token, preserving caller headers", async () => {
    let init: RequestInit | undefined
    mock.method(globalThis, "fetch", async (_url: string, i: RequestInit) => {
      init = i
      return new Response("{}")
    })
    const get = getClient(configWith({ baseURL: "https://h/v1", apiKey: "sk-test" }), "litellm")
    await get!("/search/searxng", { method: "POST", headers: { "Content-Type": "application/json" } })
    assert.deepEqual(init?.headers, { "Content-Type": "application/json", Authorization: "Bearer sk-test" })
    assert.equal(init?.method, "POST")
  })

  it("explains a rejected request when no key was found anywhere", async () => {
    for (const status of [401, 403]) {
      const [message] = await errorsFrom({ baseURL: "https://h/v1" }, status)
      assert.match(message ?? "", /no API key was found/)
      assert.match(message ?? "", /opencode auth login/)
    }
  })

  it("stays quiet when a key was sent, or when the request succeeded", async () => {
    assert.deepEqual(await errorsFrom({ baseURL: "https://h/v1", apiKey: "sk-test" }, 401), [])
    assert.deepEqual(await errorsFrom({ baseURL: "https://h/v1" }, 200), [])
  })

  it("is undefined when nothing configures a baseURL, and says so", () => {
    const errors: string[] = []
    mock.method(console, "error", (message: string) => errors.push(message))
    assert.equal(getClient(configWith({}), "litellm"), undefined)
    assert.match(errors[0] ?? "", /no baseURL for provider "litellm"/)
    assert.match(errors[0] ?? "", /LITELLM_BASE_URL/)
  })
})
