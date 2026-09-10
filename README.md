# OpenCodeLiteLLM

Plugin for [opencode](https://opencode.ai) users using [LiteLLM](https://litellm.ai) proxy:

- **`models`** — pulls the model list from LiteLLM at startup, so you stop
  hand-maintaining `provider.litellm.models` in `opencode.json`.
- **`websearch`** — replaces opencode's built-in web search with LiteLLM's
  Search Tools API (SearXNG, Brave, Tavily — whatever you have configured).

## Install

```json
{
  "plugin": ["opencode-litellm@git+https://github.com/DmitryPustovit/OpenCodeLiteLLM.git"],
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM",
      "options": { "baseURL": "https://your-litellm-host/v1" }
    }
  }
}
```

Authenticate with one of the following (if needed for your proxy):
- `opencode auth login` → LiteLLM
- Set `LITELLM_API_KEY` env variable
- `apiKey` field in provider block, where the plugin reads `baseURL` from.

### Plugin settings

Pass options with the array, example:

```json
"plugin": [["opencode-litellm@git+https://github.com/DmitryPustovit/OpenCodeLiteLLM.git", { "exclusive": true }]]
```

| option | default | meaning |
| --- | --- | --- |
| `provider` | `"litellm"` | provider id to read config from and populate |
| `exclusive` | `false` | once models load, hide every other provider (`enabled_providers`) |
| `searchTool` | `"searxng"` | LiteLLM search tool name — see `GET /search/tools` |
| `ttl` | `300000` | model list cache lifetime in ms |

## `models`

Fetches `/model/info` for context limits, pricing and capability flags.  
Falls back to `/v1/models` (names only) where that route is not permitted.   
Results are cached to `~/.cache/opencode-<provider>-models.json`, cache is updated on launch.  
Models you write by hand in `opencode.json` always win over fetched ones.  

Note that if the proxy renames a model, any name pinned in your config (`model`,
`small_model`, `agent.*.model`) goes stale silently — opencode does not validate
those strings.    
TODO: Add plugin / skill to auto update this.

## `websearch`

Replaces OpenCode's built-in web search with LiteLLM's Search Tools API.  
Sends the query to `POST /search/<tool>`, using `searxng` unless `searchTool` says otherwise.  
`GET /search/tools` lists what your proxy actually has configured.  
Returns titles, URLs and snippets, for the agent to follow up on with `webfetch`.  

**Requires `OPENCODE_ENABLE_EXA=1` in the environment.**

OpenCode only registers the `websearch` tool *name* when the opencode provider is
in use or `OPENCODE_ENABLE_EXA` / `OPENCODE_ENABLE_PARALLEL` is set. Without it
there is no `websearch` to override and the tool silently vanishes from the
agent's toolset — no error, no warning. The variable must be set before opencode
starts; assigning `process.env` from inside a plugin is too late, because the
tool registry is built before plugins evaluate.

```powershell
[Environment]::SetEnvironmentVariable("OPENCODE_ENABLE_EXA", "1", "User")
```

```bash
export OPENCODE_ENABLE_EXA=1
```

Nothing should ever reaches Exa. The variable only unlocks the name. 
This plugin supplies the implementation and a plugin tool sharing a built-in's name wins.

Because it replaces the built-in tool, it does not go through the `websearch` permission gate.    
Searches run without prompting even under `"permission": {"*": "ask"}`.  
The custom-tool context has no ask mechanism.    
TODO: This might be something to revist.

## Development

```bash
npm install
npm test        # node's built-in runner, no test dependencies
npm run typecheck
```

There is no build step. opencode ships as a Bun binary and loads `.ts` directly,
so the files in this repo are what runs directly.
`tsconfig.json` sets `noEmit` and `node_modules/` exists only so the editor and `tsc` can resolve types.

To run a local checkout instead of the published one:

```json
"plugin": [["file:/absolute/path/to/opencode-litellm", { "exclusive": true }]]
```
