# omo-vision

**Zero-config vision bridge for [OhMyOpenCode (OMO)](https://github.com/code-yeongyu/oh-my-openagent)** — lets text-only models act on pasted images.

When the active model has no image input capability, omo-vision automatically:

1. **Saves** every pasted image to the system temp directory (`…/omo-vision/image{N}/`, e.g. `/tmp/omo-vision/` on Linux)
2. **Injects a path hint** into the user message (transient — never persisted to chat history)
3. **Instructs the model** to analyze the image via OMO's built-in `look_at` tool, which runs the `multimodal-looker` agent (a vision-capable model) and returns the analysis

```
User pastes image + "what is this?"
  ↓
omo-vision plugin (experimental.chat.messages.transform)
  ├─ base64 → /tmp/omo-vision/image1/<hash>.png
  └─ append hint: "[omo-vision: Image #1 … — analyze with look_at(file_path=…)]"
  ↓
Text-only model reads the hint → calls look_at(file_path=…)
  ↓
look_at runs multimodal-looker (vision model) → analysis returned to main model
```

Native-vision models are detected via model metadata and left completely untouched — they see the original image parts and never see a hint.

## Why

- Pasted images live inline as base64 message parts, **not** on the filesystem — a text-only model cannot "save the image itself": it can't even see the part (OpenCode flags it as an unsupported part). Saving + hinting must happen in a hook before the prompt reaches the model.
- OMO's officially supported multimodal path is the `look_at` tool ([oh-my-openagent#2952](https://github.com/code-yeongyu/oh-my-openagent/issues/2952)). Routing through `look_at` also sidesteps the upstream OpenCode bug where file parts are dropped from subtask prompts — omo-vision passes a *file path*, and the vision agent reads it from disk.
- Unlike [opencode-vision](https://github.com/JochenYang/opencode-vision) (which pioneered this hook pattern — full credit), omo-vision needs **no external VLM API key and no extra agent definition**: it reuses what OMO already ships.

## Install

```bash
npx omo-vision
```

or from GitHub directly:

```bash
npx github:Gracdjd/omo-vision
```

Manual:

```bash
git clone https://github.com/Gracdjd/omo-vision
cp omo-vision/plugins/omo-vision.ts ~/.config/opencode/plugins/
```

Uninstall:

```bash
npx omo-vision --uninstall
```

Then **restart OpenCode** — plugins load at startup.

## Verify

1. Switch to a text-only model (e.g. a coding-plan model without vision)
2. Paste an image and ask "what is this?"
3. Expected: the model calls `look_at(file_path="/tmp/omo-vision/image1/<hash>.png")` and answers from the returned analysis

## Configuration (all optional — OMO defaults)

| Env var | Default | Purpose |
|---|---|---|
| `OMO_VISION_TOOL` | `look_at` | Tool the hint/instruction recommends |
| `OMO_VISION_AGENT` | `multimodal-looker` | Fallback subagent for task-tool delegation |
| `OMO_VISION_MAX_IMAGES` | `100` | LRU cap on saved image directories |
| `OMO_VISION_DIR` | `<system temp>/omo-vision` | Where images are persisted |

### Vanilla OpenCode (non-OMO)

Point the agent/tool names at your own setup:

```bash
export OMO_VISION_TOOL=read            # or your own vision tool
export OMO_VISION_AGENT=image-reader   # any subagent configured with a vision model
```

## Behavior notes

- Dedup: identical pastes (MD5 over full base64) reuse the same temp file
- LRU eviction keeps at most `OMO_VISION_MAX_IMAGES` image dirs on disk
- Stale hints are removed on every transform pass, so switching from a text-only to a vision model mid-session never leaks old hints
- Compaction/summary messages are skipped
- Write failures degrade to a skip — a broken save never kills the turn

## Development

```bash
git clone https://github.com/Gracdjd/omo-vision
cd omo-vision
bun test        # 17 unit/integration tests
```

Plugin source is a single file: [`plugins/omo-vision.ts`](plugins/omo-vision.ts). It exposes **only** `export default` — OpenCode's loader treats named exports as hooks, so helpers stay module-private. Tests drive the hooks directly and assert on the filesystem.

## License

[MIT](LICENSE) — mechanism inspired by [@jochenyang/opencode-vision](https://github.com/JochenYang/opencode-vision) (MIT).
