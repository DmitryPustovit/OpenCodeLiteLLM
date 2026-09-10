/**
 * Pulls the model list from a LiteLLM proxy at startup, so `provider.<id>.models`
 * does not have to be maintained by hand.
 */
import type { Config, Plugin } from "@opencode-ai/plugin"
import { readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import {
  getClient,
  getPluginSettings,
  PLUGIN_NAME,
  type Client,
  type ResolvedPluginSettings,
} from "./shared.ts"

/* OpenCode Types */
type ProviderConfig = NonNullable<Config["provider"]>[string]
type ModelMap = NonNullable<ProviderConfig["models"]>

/**
 * Fields we use from LiteLLM's /model/info.
 * */
type LiteLLMModelInfo = {
  max_input_tokens?: number | string | null
  max_output_tokens?: number | string | null
  input_cost_per_token?: number | string | null
  output_cost_per_token?: number | string | null
  cache_read_input_token_cost?: number | string | null
  supports_function_calling?: boolean | null
  supports_reasoning?: boolean | null
  supports_vision?: boolean | null
}

type ModelInfoResponse = { data?: Array<{ model_name: string; model_info?: LiteLLMModelInfo }> }
type CacheFile = { fetchedAtMs: number; models: ModelMap }

/**
 * Normalzie loosely type response into number.
 * @param value number value
 * @param fallback fallback response is value is invalid
 * @returns valid number
 */
const num = (value: unknown, fallback: number): number => value == null || !Number.isFinite(Number(value)) ? fallback : Number(value)

/**
 * Handle conversion of cost per token into cost per million tokens.
 * Calls `num` to handle loosly typed inputs.
 * @param value cost per token
 * @returns cost per million tokens
 */
const perMillion = (value: unknown): number => num(value, 0) * 1e6

async function fetchModels(client: Client): Promise<ModelMap> {
  const request = await client("/model/info", { signal: AbortSignal.timeout(10000) })
  if (!request.ok) throw new Error(`litellm ${request.status}`)

  const { data = [] } = (await request.json()) as ModelInfoResponse
  return Object.fromEntries(
    data.map((m) => {
      const i = m.model_info ?? {}
      return [
        m.model_name,
        {
          name: m.model_name,
          tool_call: i.supports_function_calling ?? true,
          reasoning: i.supports_reasoning ?? false,
          attachment: i.supports_vision ?? false,
          limit: { context: num(i.max_input_tokens, 128000), output: num(i.max_output_tokens, 8192) },
          cost: {
            input: perMillion(i.input_cost_per_token),
            output: perMillion(i.output_cost_per_token),
            cache_read: perMillion(i.cache_read_input_token_cost),
          },
          modalities: {
            input: i.supports_vision ? (["text", "image"] as const) : (["text"] as const),
            output: ["text"] as const,
          },
        },
      ]
    }),
  ) as ModelMap
}

/**
 * Path to Cache file.
 * Provider specific so two proxies do not share files.
 *
 * @param provider - provider id
 */
function getCachePath(provider: string): string {
  return join(homedir(), ".cache", `opencode-${provider}-models.json`)
}

/**
 * Read the model cache.
 *
 * @param cachePath - cache file to read
 * @returns the cached list, or undefined if there is not a usable one
 */
function readCache(cachePath: string): CacheFile | undefined {
  try {
    return JSON.parse(readFileSync(cachePath, "utf8")) as CacheFile
  } catch (e) {
    // No cache yet is the normal first launch and stays quiet.
    // Anything else means the file is there but unusable.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`${PLUGIN_NAME}: could not read ${cachePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/**
 * Fetch the model list and cache it.
 * Fall back to cache when the proxy cannot be reached.
 *
 * @param client - client for the proxy
 * @param cachePath - cache file to write
 * @param cached - what the last launch saved, if anything
 * @returns the models to use, or undefined when there is nothing to fall back on
 */
async function loadModels(client: Client, cachePath: string, cached?: CacheFile): Promise<ModelMap | undefined> {
  try {
    const models = await fetchModels(client)
    writeFileSync(cachePath, JSON.stringify({ fetchedAtMs: Date.now(), models } satisfies CacheFile))
    return models
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!cached) {
      console.error(`${PLUGIN_NAME}: ${message}, no models loaded. Cache does not exist.`)
      return
    }
    console.error(`${PLUGIN_NAME}: ${message}, using last known model list from cache.`)
    return cached.models
  }
}

/**
 * Put the fetched models into opencode's config.
 * The `config` hook is handed the object opencode is about to use,
 * so editing it in place carries into the session.
 *
 * @param config - opencode's config, edited in place
 * @param pluginSettings - this plugin settings
 * @param models - model list to write
 */
function updateProviderConfig(config: Config, pluginSettings: ResolvedPluginSettings, models: ModelMap): void {
  const providers = (config.provider ??= {})
  const existingModels: ProviderConfig = providers[pluginSettings.provider] ?? {}

  providers[pluginSettings.provider] = {
    npm: "@ai-sdk/openai-compatible",
    name: "LiteLLM",
    // whatever opencode.json already said wins over updates
    ...existingModels,
    // Per model written.
    models: { ...models, ...(existingModels.models ?? {}) },
  }

  // Only pinned once a list exists, otherwise a failed fetch would leave no models at all.
  if (pluginSettings.exclusive) config.enabled_providers = [pluginSettings.provider]
}

export const models: Plugin = async (_input, jsonConfig = {}) => {
  const pluginSettings = getPluginSettings(jsonConfig)
  const cachePath = getCachePath(pluginSettings.provider)

  return {
    async config(config) {
      const client = getClient(config, pluginSettings.provider)
      if (!client) return

      const cached = readCache(cachePath)
      if (cached && Date.now() - cached.fetchedAtMs < pluginSettings.ttl) {
        return updateProviderConfig(config, pluginSettings, cached.models)
      }

      const models = await loadModels(client, cachePath, cached)
      if (models) updateProviderConfig(config, pluginSettings, models)
    },
  }
}
