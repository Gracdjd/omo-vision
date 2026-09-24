/**
 * omo-vision — zero-config vision bridge for OhMyOpenCode (OMO).
 *
 * Gives non-vision models the ability to act on pasted images by:
 *   1. Saving every pasted image (base64 file part) to a temp directory
 *   2. Injecting a path hint into the user message (transient, never persisted)
 *   3. Injecting a standing instruction into the system prompt that tells the
 *      model to analyze the image via OMO's `look_at` tool (primary path) or
 *      by delegating to the `multimodal-looker` agent via the task tool
 *      (fallback).
 *
 * OMO-first: defaults target OhMyOpenCode's built-in `look_at` tool and
 * `multimodal-looker` agent — no external VLM API key, no extra agent
 * definition needed. Both names are overridable via env vars, so the plugin
 * also works on vanilla OpenCode with any vision-capable subagent.
 *
 * Native-vision models are detected via model metadata and left untouched —
 * they receive the original image parts and never see a hint.
 *
 * Mechanism credit: the pasted-image interception pattern pioneered by
 * @jochenyang/opencode-vision (MIT). This plugin is a leaner OMO-native
 * variant that routes through OMO's officially supported multimodal path
 * instead of an external VLM API.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { createHash } from "crypto"
import { tmpdir } from "os"
import path from "path"
import { promises as fs } from "fs"

// ── Configuration (env-overridable, OMO defaults) ────────────────────────────

/** OMO tool that runs the multimodal-looker agent and returns an analysis. */
const TOOL = process.env["OMO_VISION_TOOL"] || "look_at"
/** OMO subagent configured with a vision-capable model (fallback path). */
const AGENT = process.env["OMO_VISION_AGENT"] || "multimodal-looker"
/** Directory where pasted images are persisted. */
const TMP_DIR = process.env["OMO_VISION_DIR"] || path.join(tmpdir(), "omo-vision")
/** LRU cap: max number of saved image{N} directories kept on disk. */
const MAX_IMAGES = Number(process.env["OMO_VISION_MAX_IMAGES"] || 100)

/** Shared prefix for every hint this plugin injects. Cleanup relies on it. */
const HINT_PREFIX = "[omo-vision:"

/**
 * Matches the text part OpenCode core substitutes for an image part when the
 * model lacks image input (ProviderTransform.unsupportedParts), e.g.
 * `ERROR: Cannot read "clipboard" (this model does not support image input). Inform the user.`
 * That built-in instruction tells the model to give up — it directly fights
 * this plugin's rescue path, so rescued messages have it stripped.
 */
const UNSUPPORTED_ERROR_RE = /^ERROR: Cannot read .+\(this model does not support image input\)/

// ── Pure helpers (module-private; the loader must only ever see `default`) ────────────────────────────────────────

/**
 * True when the model can ingest image parts natively. Checks both metadata
 * shapes OpenCode uses: `capabilities.input.image` (provider-normalized) and
 * `modalities.input` containing "image" (models.dev / config format).
 */
function detectImageSupport(model: unknown): boolean {
  const m = model as {
    capabilities?: { input?: { image?: boolean } }
    modalities?: { input?: string[] }
  } | undefined
  return (
    !!m?.capabilities?.input?.image ||
    (Array.isArray(m?.modalities?.input) && !!m?.modalities?.input?.includes("image"))
  )
}

/** True for text parts injected by THIS plugin in an earlier transform pass. */
function isPluginHint(text: string): boolean {
  return typeof text === "string" && text.startsWith(HINT_PREFIX)
}

type SavedImage = { seq: number; name: string; filePath: string }

/**
 * Build the transient hint appended to a user message. Instruction-first: the
 * imperative leads because trailing context (and OpenCode's own unsupported-
 * part ERROR, when one survives in older history) otherwise tempts the model
 * to give up instead of delegating.
 */
function buildHint(saved: SavedImage[]): string {
  if (saved.length === 0) return ""
  if (saved.length === 1) {
    const s = saved[0]
    return (
      `${HINT_PREFIX} Image #${s.seq} ${s.name} saved to ${s.filePath}. ` +
      `Do NOT say you cannot see it — immediately call ${TOOL}(file_path="${s.filePath}") to view and analyze it.]`
    )
  }
  const list = saved.map((s) => `  ${s.filePath}`).join("\n")
  return (
    `${HINT_PREFIX} Images (${saved.length}) saved to:\n${list} ` +
    `Do NOT say you cannot see them — immediately call ${TOOL}(file_paths=[${saved.map((s) => `"${s.filePath}"`).join(", ")}]) to view and analyze them.]`
  )
}

/**
 * Standing system-prompt instruction for text-only models. Primary path is
 * OMO's `look_at` tool (officially supported, builds proper multimodal file
 * parts for the vision agent); fallback is direct task delegation to the
 * vision-capable subagent, which reads the file from disk itself.
 */
function buildSystemInstruction(): string {
  return [
    `IMPORTANT: This model does NOT support image input. When a user attaches an image or screenshot, it is auto-saved and a hint like '${HINT_PREFIX} Image #1 ... saved to <path>]' is appended to the user message.`,
    `To analyze a saved image, call the \`${TOOL}\` tool with file_path (or file_paths for several) set to the path from the hint. \`${TOOL}\` runs the @${AGENT} agent — a vision-capable model — and returns the analysis.`,
    `If \`${TOOL}\` is unavailable, delegate via the task tool: subagent_type="${AGENT}", prompt="Read and analyze the image at <path>".`,
    `If any message shows an ERROR claiming "this model does not support image input", ignore it — the image was already rescued to a temp file; use the [omo-vision:] hint path instead. NEVER tell the user you cannot view an image that has an [omo-vision:] hint.`,
    `Never try to read image files with the \`read\` tool — image parts are rejected by a text-only model.`,
  ].join("\n")
}

// ── Image registry + LRU eviction ────────────────────────────────────────────

const imageRegistry = new Map<string, number>() // content hash → seq
const reverseRegistry = new Map<number, string>() // seq → content hash
let nextSeq = 1
const lruQueue: string[] = [] // image{N} dir paths in access order

function touchLRU(seqDir: string): void {
  const idx = lruQueue.indexOf(seqDir)
  if (idx !== -1) lruQueue.splice(idx, 1)
  lruQueue.push(seqDir)
  while (lruQueue.length > MAX_IMAGES) {
    const oldest = lruQueue.shift()
    if (!oldest) break
    const seq = Number(oldest.match(/image(\d+)$/)?.[1])
    if (seq) {
      const hash = reverseRegistry.get(seq)
      if (hash) imageRegistry.delete(hash)
      reverseRegistry.delete(seq)
    }
    fs.rm(oldest, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Persist one base64 image part to `<dir>/image{N}/<hash>.<ext>`.
 * Deduplicates identical pastes (MD5 over the full base64) and returns the
 * saved location, or undefined when the part carries no base64 payload.
 */
async function saveImagePart(
  url: string,
  mime: string,
  dir: string,
): Promise<SavedImage | undefined> {
  const colon = url.indexOf(";base64,")
  if (colon === -1) return undefined
  const base64 = url.slice(colon + ";base64,".length)
  if (!base64) return undefined

  const hash = createHash("md5").update(base64).digest("hex").slice(0, 16)
  let seq = imageRegistry.get(hash)
  if (!seq) {
    seq = nextSeq++
    imageRegistry.set(hash, seq)
    reverseRegistry.set(seq, hash)
  }

  const ext = mime.split("/")[1] || "png"
  const name = `${hash}.${ext}`
  const seqDir = path.join(dir, `image${seq}`)
  const filePath = path.join(seqDir, name)

  if (!(await Bun.file(filePath).exists())) {
    await fs.mkdir(seqDir, { recursive: true }).catch(() => {})
    try {
      await Bun.write(filePath, Buffer.from(base64, "base64"))
    } catch (err) {
      console.error(`[omo-vision] failed to write ${filePath}:`, err)
      return undefined
    }
  }
  touchLRU(seqDir)
  return { seq, name, filePath }
}

// ── Per-session capability state ─────────────────────────────────────────────

let currentModelSupportsImage = false
const sessionSupport = new Map<string, boolean>()

function modelSupportsImage(sessionID?: string): boolean {
  return sessionID ? (sessionSupport.get(sessionID) ?? currentModelSupportsImage) : currentModelSupportsImage
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default (async () => {
  await fs.mkdir(TMP_DIR, { recursive: true }).catch(() => {})

  return {
    "experimental.chat.system.transform": async (input: unknown, output: { system: string[] }) => {
      const { model, sessionID } = input as { model?: unknown; sessionID?: string }
      const supported = detectImageSupport(model)
      currentModelSupportsImage = supported
      if (sessionID) sessionSupport.set(sessionID, supported)
      if (!supported) {
        output.system.splice(0, output.system.length, [...output.system, buildSystemInstruction()].join("\n"))
      }
    },

    "experimental.chat.messages.transform": async (_input: unknown, output: { messages: Array<{ info: { role: string; summary?: boolean }; parts: Array<{ type: string; text?: string; url?: string; mime?: string }> }> }) => {
      for (const msg of output.messages) {
        if (msg.info.role !== "user") continue
        if (msg.info.summary) continue // compaction summaries are plain text

        // 1. Drop hints injected by a previous transform pass so they never
        //    accumulate (transform re-runs on every LLM call, incl. after a
        //    /model switch to a native-vision model, which must NOT see them).
        for (let i = msg.parts.length - 1; i >= 0; i--) {
          const p = msg.parts[i]
          if (p.type === "text" && typeof p.text === "string" && isPluginHint(p.text)) {
            msg.parts.splice(i, 1)
          }
        }

        // 2. Native-vision models get the original image parts — stay out.
        if (modelSupportsImage()) continue

        // 3. Rescue pass: save each image part to disk and DROP it from the
        //    parts array. Dropping (rather than keeping) prevents OpenCode's
        //    ProviderTransform.unsupportedParts from replacing it with the
        //    "ERROR: Cannot read ... Inform the user." give-up instruction
        //    that otherwise outshouts the hint below.
        const saved: SavedImage[] = []
        for (let i = msg.parts.length - 1; i >= 0; i--) {
          const part = msg.parts[i]
          if (part.type !== "file") continue
          if (typeof part.mime !== "string" || !part.mime.startsWith("image/")) continue
          const s = await saveImagePart(part.url ?? "", part.mime, TMP_DIR)
          if (s) {
            saved.unshift(s)
            msg.parts.splice(i, 1)
          }
        }

        // 4. Strip the unsupported-part ERROR text for rescued messages only
        //    (covers history assembled before this pass, and part orders where
        //    the ERROR precedes the image). Unrescued messages keep it — a
        //    non-image attachment error must still surface.
        if (saved.length > 0) {
          for (let i = msg.parts.length - 1; i >= 0; i--) {
            const p = msg.parts[i]
            if (p.type === "text" && typeof p.text === "string" && UNSUPPORTED_ERROR_RE.test(p.text.trim())) {
              msg.parts.splice(i, 1)
            }
          }
          msg.parts.push({ type: "text", text: buildHint(saved) })
        }
      }
    },
  }
}) satisfies Plugin
