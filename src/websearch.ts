/**
 * Replaces OpenCode's built-in `websearch` tool with one backed by the LiteLLM
 * Search Tools API.
 * (Configured to use SearXNG by default.)
 *
 * Note:
 * Requires OPENCODE_ENABLE_EXA=1 (or OPENCODE_ENABLE_PARALLEL) in the
 * environment. OpenCode only registers the `websearch` tool name when the
 * OpenCode provider is in use or one of those is set.
 * Without it there is no `websearch` to override and this tool silently vanishes.
 * It must be set before OpenCode starts. The tool registry is built before plugins
 * evaluate, so assigning process.env from here is too late.
 */
import { tool, type Plugin } from "@opencode-ai/plugin"
import { getClient, getPluginSettings, type Client } from "./shared.ts"

type SearchResult = { title?: string; url: string; snippet?: string }
type SearchResponse = { results?: SearchResult[]; error?: { message?: string } }

/** Results returned when the model does not ask for a count, matching opencode's built-in. */
const DEFAULT_RESULTS = 8

/** Ceiling on what the model may ask for. */
const MAX_RESULTS = 25

/** Longest snippet we return to agent, result should stays a couple of lines. */
const SNIPPET_LIMIT = 400

/** Results are returned as an indented, numbered list, one blank line apart. */
const RESULT_SEPARATOR = "\n\n"

/**
 * Render result for the agent to read.
 *
 * Example:
 * ```
 * 1. Some page title
 *    https://example.com/page
 *    The snippet, if the search tool returned one.
 * ```
 *
 * @param searchResult - single entry from the search response
 * @param index - its position, for the visible numbering
 */
function formatResult(searchResult: SearchResult, index: number): string {
  // "1. " leads the first line.
  // The following indexes get matching blank space.
  // This keeps results aligned once the list reaches double digits.
  const label = `${index + 1}. `
  const indent = " ".repeat(label.length)

  const lines = [label + (searchResult.title ?? searchResult.url), indent + searchResult.url]

  // Snippets arrive with the source page's line breaks and padding in them.
  const snippet = (searchResult.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, SNIPPET_LIMIT)
  if (snippet) {
    lines.push(indent + snippet)
  }

  return lines.join("\n")
}

export const websearch: Plugin = async (_input, settings = {}) => {
  const { provider: PROVIDER, searchTool } = getPluginSettings(settings)
  let client: Client | undefined

  return {
    // The tool hook is not handed the config, so capture what it needs here.
    async config(config) {
      client = getClient(config, PROVIDER)
    },

    tool: {
      websearch: tool({
        description: [
          "Search the web and return matching pages with titles, URLs and snippets.",
          "Use this for current information, documentation, or anything outside the codebase.",
          "Follow up with the webfetch tool to read a specific result in full.",
        ].join(" "),
        args: {
          query: tool.schema.string().describe("The search query"),
          // Named to match opencode's built-in websearch, so a model that has
          // used that tool calls this one correctly. LiteLLM's own field for
          // the same thing is `max_results`.
          numResults: tool.schema
            .number()
            .int()
            .min(1)
            .max(MAX_RESULTS)
            .optional()
            .describe("Number of search results to return (default: 8)"),
        },
        async execute(args, ctx) {
          if (!client) {
            throw new Error(`no ${PROVIDER} baseURL configured`)
          }

          ctx.metadata({ title: args.query, metadata: { query: args.query, provider: searchTool } })

          const res = await client(`/search/${searchTool}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: args.query }),
            signal: ctx.abort,
          })

          // Fetch the search results from the request.
          const searchResponse = (await res.json().catch(() => ({}))) as SearchResponse
          if (!res.ok) {
            throw new Error(searchResponse.error?.message ?? `${searchTool} search failed (${res.status})`)
          }

          // Get the search results.
          const results = (searchResponse.results ?? []).slice(0, args.numResults ?? DEFAULT_RESULTS)
          if (!results.length) {
            return `No results for "${args.query}".`
          }

          return results.map(formatResult).join(RESULT_SEPARATOR)
        },
      }),
    },
  }
}
