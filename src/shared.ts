import type { Config, PluginOptions } from "@opencode-ai/plugin"
import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

/** Prefix for anything this package prints. */
export const PLUGIN_NAME = "OpenCodeLiteLLM"

/*
    Plugin Provided Settings
*/

export type PluginSettings = {
  /** Provider id. */
  provider?: string
  /** Hide all other providers once the model list loads. */
  exclusive?: boolean
  /** LiteLLM search tool name, from GET /search/tools. */
  searchTool?: string
  /** Model list cache lifetime in ms. */
  ttl?: number
}

/** PluginSettings with no optional fields. */
export type ResolvedPluginSettings = Required<PluginSettings>

/** PluginSettting Defaults */
const DEFAULTS: ResolvedPluginSettings = {
  provider: "litellm",
  exclusive: false,
  searchTool: "searxng",
  ttl: 1000 * 60 * 5,
}

 /**
  * Accept json configs from `plugin` field in opencode.json.
  * Use provided configs when present, otherwise use defaults in `DEFAULTS`.
  *
  * @param jsonConfig - opencode json plugin settings
  * @returns ResolvedPluginSettings - Settings for plugin, either provided via opencode json or defaults.
  */
export function getPluginSettings(jsonConfig: PluginOptions = {}): ResolvedPluginSettings {
  const given = jsonConfig as PluginSettings
  return {
    provider: given.provider ?? DEFAULTS.provider,
    exclusive: given.exclusive ?? DEFAULTS.exclusive,
    searchTool: given.searchTool ?? DEFAULTS.searchTool,
    ttl: given.ttl ?? DEFAULTS.ttl,
  }
}

/*
    OpenCode Provider Settings
*/

export type ProviderSettings = {
  /** Root URL of the LiteLLM proxy, with or without a `/v1` suffix. */
  baseURL?: string
  /** API Key to send as a bearer token. */
  apiKey?: string
}

/**
 * Read auth keys associated with a `provider` from auth file writen by the `opencode auth login` process.
 * This is needed because OpenCode resovles auth internally for chat requests and does not provide it for plugins.
 *
 * @param provider - provider id, matching the key in auth.json
 * @returns the stored key, or undefined if the file or the entry is missing
 */
function storedKey(provider: string): string | undefined {
  const auth = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json")
  try {
    return JSON.parse(readFileSync(auth, "utf8"))[provider]?.key
  } catch (e) {
    // Never having logged in is the normal case and stays quiet.
    // A corrupt or unreadable file is not, and would otherwise surface only as a bare 401.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`${PLUGIN_NAME}: could not read ${auth}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/** Calls one route on the proxy. Paths start with "/". */
export type Client = (path: string, init?: RequestInit) => Promise<Response>

/**
 * Set where the proxy is and how to authenticate to it.
 * Bind both into one callable, so nothing downstream has to carry a URL and a key around together.
 *
 * The LiteLLM base URL can be provided via the provider.options.baseURL field in
 * opencode.json OR via LITELLM_BASE_URL env variable.
 *
 * The LiteLLM API KEY may be set in three ways:
 *  - OpenCode config JSON (Most Unsecure)
 *  - LITELLM_API_KEY ENV Variable
 *  - `stored key` which is set via OpenCode's auth process. (opencode auth login)
 *
 * @param config - opencode's json config
 * @param provider - provider id, e.g. "litellm"
 * @returns a function taking a path.
 */
export function getClient(config: Config, provider: string): Client | undefined {
  const providerSettings: ProviderSettings = config.provider?.[provider]?.options ?? {}
  const configured = providerSettings.baseURL ?? process.env.LITELLM_BASE_URL
  if (!configured) {
    // Not a error per say — the plugin is installed without a provider block and/or baseURL to read.
    // Left silent, it looks like the plugin never ran at all.
    console.error(
      `${PLUGIN_NAME}: no baseURL for provider "${provider}". ` +
        `Set provider.${provider}.options.baseURL in opencode.json, or LITELLM_BASE_URL env variable.`,
    )
    return
  }

  // LiteLLM serves every route we use under both `/` and `/v1`.
  // No need to modify the configured URL in either case.
  // Only handling trailing slash that would double up.
  const baseURL = configured.replace(/\/+$/, "")

  // Grab the API key via one of the three options.
  const apiKey = providerSettings.apiKey ?? process.env.LITELLM_API_KEY ?? storedKey(provider)

  return async (path, init) => {
    const res = await fetch(`${baseURL}${path}`, {
      ...init,
      headers: { ...init?.headers, ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    })

    // Error if we need an API key in for this proxy endpoint.
    if (!apiKey && (res.status === 401 || res.status === 403)) {
      console.error(
        `${PLUGIN_NAME}: ${res.status} from ${baseURL} and no API key was found. ` +
          `Run \`opencode auth login\`, or set provider.${provider}.options.apiKey, or LITELLM_API_KEY.`,
      )
    }
    return res
  }
}
