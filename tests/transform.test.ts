import { describe, expect, test, beforeAll } from "bun:test"
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"

// The plugin file must expose ONLY `export default` — OpenCode's plugin loader
// treats named exports as hooks and mis-calls them. Tests therefore drive
// everything through the returned hooks plus filesystem observations.

// 1×1 transparent PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const PNG_URL = `data:image/png;base64,${TINY_PNG_BASE64}`
const SECOND_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mPnxgAAaQABJREFUCNdjYKAV" // distinct content
const SECOND_PNG_URL = `data:image/png;base64,${SECOND_PNG_BASE64}`

const TEST_DIR = join(import.meta.dir, ".tmp-omo-vision")
const HINT_PREFIX = "[omo-vision:"

process.env["OMO_VISION_DIR"] = TEST_DIR
process.env["OMO_VISION_MAX_IMAGES"] = "3"

type Part = Record<string, string>
type Message = { info: { role: string; summary?: boolean }; parts: Part[] }
type MessagesOut = { messages: Message[] }
type ToolExecInput = { tool: string; sessionID?: string; args?: { filePath?: string; path?: string } }
type PluginHooks = {
  "experimental.chat.system.transform": (i: unknown, o: { system: string[] }) => Promise<void>
  "experimental.chat.messages.transform": (i: unknown, o: MessagesOut) => Promise<void>
  "tool.execute.before": (i: ToolExecInput, o: { args?: Record<string, unknown> }) => Promise<void>
}

// Import AFTER env is set — module reads OMO_VISION_DIR at load time.
const plugin = (await import("../plugins/omo-vision.ts")).default
const hooks = (await plugin()) as PluginHooks

const TEXT_ONLY = { model: { modalities: { input: ["text"] } }, sessionID: "s-text" }
const VISION = { model: { modalities: { input: ["text", "image"] } }, sessionID: "s-vision" }

function userMsg(...parts: Part[]): MessagesOut {
  return { messages: [{ info: { role: "user" }, parts }] }
}
/** Reset per-transform model state to text-only (hooks share module-level state). */
async function asTextOnly(): Promise<void> {
  await hooks["experimental.chat.system.transform"](TEXT_ONLY, { system: [] })
}
function hintParts(out: MessagesOut): string[] {
  return out.messages[0].parts
    .filter((p) => p.type === "text" && p.text.startsWith(HINT_PREFIX))
    .map((p) => p.text)
}
function savedFiles(): string[] {
  const files: string[] = []
  for (const dir of readdirSync(TEST_DIR)) {
    const sub = join(TEST_DIR, dir)
    if (dir.startsWith("image")) for (const f of readdirSync(sub)) files.push(f)
  }
  return files
}

beforeAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

describe("system.transform", () => {
  test("text-only model gets the delegation instruction", async () => {
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"](TEXT_ONLY, out)
    expect(out.system).toHaveLength(1)
    expect(out.system[0]).toContain("BASE")
    expect(out.system[0]).toContain("`look_at`")
    expect(out.system[0]).toContain('subagent_type="multimodal-looker"')
    expect(out.system[0]).toContain("does NOT support image input")
    expect(out.system[0]).toContain("NEVER tell the user you cannot view an image")
  })

  test("vision model gets NO instruction", async () => {
    const out = { system: ["BASE"] }
    await hooks["experimental.chat.system.transform"](VISION, out)
    expect(out.system).toEqual(["BASE"])
  })
})

describe("messages.transform", () => {
  test("text-only model: image saved to disk, hint appended", async () => {
    await asTextOnly()
    const out = userMsg(
      { type: "text", text: "what is this?" },
      { type: "file", mime: "image/png", url: PNG_URL },
    )
    await hooks["experimental.chat.messages.transform"](undefined, out)
    expect(out.messages[0].parts).toHaveLength(2)
    expect(out.messages[0].parts.some((p) => p.type === "file")).toBe(false)
    const hints = hintParts(out)
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain('look_at(file_path="')
    expect(hints[0]).toContain("Do NOT say you cannot see")
    expect(hints[0]).toContain("image/png".split("/")[1]) // .png name
    expect(savedFiles().length).toBeGreaterThan(0)
  })

  test("multiple images: hint uses file_paths array, all saved", async () => {
    await asTextOnly()
    const out = userMsg(
      { type: "file", mime: "image/png", url: PNG_URL },
      { type: "file", mime: "image/png", url: SECOND_PNG_URL },
    )
    await hooks["experimental.chat.messages.transform"](undefined, out)
    expect(out.messages[0].parts.some((p) => p.type === "file")).toBe(false)
    const hints = hintParts(out)
    expect(hints).toHaveLength(1)
    expect(hints[0]).toContain("Images (2)")
    expect(hints[0]).toContain("Do NOT say you cannot see")
    expect(hints[0]).toContain('file_paths=["')
    expect(savedFiles()).toHaveLength(2)
  })

  test("identical paste deduped to the same file", async () => {
    await asTextOnly()
    const before = savedFiles().length
    const out = userMsg({ type: "file", mime: "image/png", url: PNG_URL })
    await hooks["experimental.chat.messages.transform"](undefined, out)
    await hooks["experimental.chat.messages.transform"](undefined, out)
    expect(savedFiles().length).toBe(before + 0) // no new file for repeat paste
  })

  test("unsupported-part ERROR stripped when image rescued", async () => {
    await asTextOnly()
    const out = userMsg(
      { type: "text", text: "what is this?" },
      { type: "text", text: 'ERROR: Cannot read "clipboard" (this model does not support image input). Inform the user.' },
      { type: "file", mime: "image/png", url: PNG_URL },
    )
    await hooks["experimental.chat.messages.transform"](undefined, out)
    const texts = out.messages[0].parts.filter((p) => p.type === "text").map((p) => p.text)
    expect(texts.some((t) => t.startsWith("ERROR: Cannot read"))).toBe(false)
    expect(hintParts(out)).toHaveLength(1)
  })

  test("ERROR part before the image is also stripped", async () => {
    await asTextOnly()
    const out = userMsg(
      { type: "file", mime: "image/png", url: PNG_URL },
      { type: "text", text: 'ERROR: Cannot read "clipboard" (this model does not support image input). Inform the user.' },
    )
    await hooks["experimental.chat.messages.transform"](undefined, out)
    const texts = out.messages[0].parts.filter((p) => p.type === "text").map((p) => p.text)
    expect(texts.some((t) => t.startsWith("ERROR: Cannot read"))).toBe(false)
  })

  test("unsupported-part ERROR kept when no image rescued", async () => {
    await asTextOnly()
    const out = userMsg(
      { type: "text", text: "see this pdf" },
      { type: "text", text: 'ERROR: Cannot read "doc.pdf" (this model does not support image input). Inform the user.' },
    )
    await hooks["experimental.chat.messages.transform"](undefined, out)
    const texts = out.messages[0].parts.filter((p) => p.type === "text").map((p) => p.text)
    expect(texts.some((t) => t.startsWith("ERROR: Cannot read"))).toBe(true)
  })

  test("non-base64 file parts (file:// urls) are ignored", async () => {
    await asTextOnly()
    const out = userMsg({ type: "file", mime: "image/png", url: "file:///tmp/x.png" })
    await hooks["experimental.chat.messages.transform"](undefined, out)
    expect(hintParts(out)).toHaveLength(0)
  })

  test("stale hints from earlier passes removed, never duplicated", async () => {
    await asTextOnly()
    const out = userMsg(
      { type: "text", text: "what is this?" },
      { type: "file", mime: "image/png", url: PNG_URL },
      { type: "text", text: "[omo-vision: Image #9 old.png auto-saved to /tmp/old — stale]" },
    )
    await hooks["experimental.chat.messages.transform"](undefined, out)
    const hints = hintParts(out)
    expect(hints).toHaveLength(1)
    expect(hints[0]).not.toContain("stale")
  })

  test("vision model: no new hint, stale hint still cleaned", async () => {
    await hooks["experimental.chat.system.transform"](VISION, { system: [] })
    const out = userMsg(
      { type: "file", mime: "image/png", url: SECOND_PNG_URL },
      { type: "text", text: "[omo-vision: Image #9 old.png auto-saved to /tmp/old — stale]" },
    )
    const filesBefore = savedFiles().length
    await hooks["experimental.chat.messages.transform"](undefined, out)
    expect(hintParts(out)).toHaveLength(0)
    expect(savedFiles().length).toBe(filesBefore) // nothing saved for vision model
  })

  test("assistant and summary messages are ignored", async () => {
    await asTextOnly()
    await hooks["experimental.chat.system.transform"](TEXT_ONLY, { system: [] })
    const out: MessagesOut = {
      messages: [
        { info: { role: "assistant" }, parts: [{ type: "file", mime: "image/png", url: SECOND_PNG_URL }] },
        { info: { role: "user", summary: true }, parts: [{ type: "file", mime: "image/png", url: SECOND_PNG_URL }] },
      ],
    }
    await hooks["experimental.chat.messages.transform"](undefined, out)
    expect(out.messages[0].parts).toHaveLength(1)
    expect(out.messages[1].parts).toHaveLength(1)
  })

  test("read guard: text-only model redirected to sidecar note", async () => {
    await asTextOnly()
    // rescue an image first so the file exists
    const out = userMsg({ type: "file", mime: "image/png", url: PNG_URL })
    await hooks["experimental.chat.messages.transform"](undefined, out)
    const hint = hintParts(out)[0]
    const savedPath = hint.match(/saved to (\S+\.png)/)![1]
    const exec: ToolExecInput = { tool: "read", sessionID: "s-text", args: { filePath: savedPath } }
    const execOut: { args?: Record<string, unknown> } = {}
    await hooks["tool.execute.before"](exec, execOut)
    expect(execOut.args?.filePath).toBe(savedPath + ".txt")
    expect(execOut.args?.path).toBe(savedPath + ".txt")
    const note = readFileSync(savedPath + ".txt", "utf8")
    expect(note).toContain("is an IMAGE")
    expect(note).toContain('look_at(file_path="')
  })

  test("read guard: vision model and foreign paths untouched", async () => {
    await hooks["experimental.chat.system.transform"](VISION, { system: [] })
    const out = userMsg({ type: "file", mime: "image/png", url: PNG_URL })
    await hooks["experimental.chat.messages.transform"](undefined, out)
    const hint = hintParts(out)
    const savedPath = hint.length ? hint[0].match(/saved to (\S+\.png)/)![1] : "/nonexistent.png"
    // vision state: no hint injected (plugin silent), guard must not rewrite
    const execOut: { args?: Record<string, unknown> } = {}
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "s-vision", args: { filePath: "/var/folders/x/omo-vision/image1/a.png" } }, execOut)
    expect(execOut.args).toBeUndefined()
    // outside TMP_DIR: untouched
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "s-vision", args: { filePath: "/etc/hosts" } }, execOut)
    expect(execOut.args).toBeUndefined()
    expect(savedPath.length).toBeGreaterThan(0)
  })

  test("temp dir auto-created at plugin init", () => {
    expect(existsSync(TEST_DIR)).toBe(true)
  })
})
