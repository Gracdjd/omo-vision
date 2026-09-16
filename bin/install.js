#!/usr/bin/env node
/**
 * omo-vision installer — zero dependencies, runs on Node >= 18.
 *
 * Install:   npx github:Gracdjd/omo-vision
 * Uninstall: npx github:Gracdjd/omo-vision --uninstall
 *
 * Copies plugins/omo-vision.ts into OpenCode's auto-discovered plugin
 * directory (~/.config/opencode/plugins/). No opencode.json changes needed.
 */
const { existsSync, mkdirSync, copyFileSync, rmSync } = require("fs")
const { join } = require("path")
const { homedir } = require("os")

const UNINSTALL = process.argv.includes("--uninstall")
const SRC = join(__dirname, "..", "plugins", "omo-vision.ts")
const DEST_DIR = join(homedir(), ".config", "opencode", "plugins")
const DEST = join(DEST_DIR, "omo-vision.ts")

if (UNINSTALL) {
  if (!existsSync(DEST)) {
    console.log("[omo-vision] not installed — nothing to remove.")
    process.exit(0)
  }
  rmSync(DEST)
  console.log(`[omo-vision] removed ${DEST}`)
  console.log("[omo-vision] restart OpenCode to finish uninstalling.")
  process.exit(0)
}

if (!existsSync(SRC)) {
  console.error(`[omo-vision] source not found: ${SRC}`)
  process.exit(1)
}

mkdirSync(DEST_DIR, { recursive: true })
copyFileSync(SRC, DEST)

console.log(`[omo-vision] installed → ${DEST}`)
console.log("")
console.log("Next steps:")
console.log("  1. Restart OpenCode (plugins load at startup).")
console.log("  2. Paste an image and ask about it — non-vision models will")
console.log("     auto-delegate to multimodal-looker via look_at(file_path=...).")
console.log("")
console.log("Optional env vars (OMO defaults shown):")
console.log("  OMO_VISION_TOOL=look_at          # analysis tool to recommend")
console.log("  OMO_VISION_AGENT=multimodal-looker # fallback subagent for task delegation")
console.log("  OMO_VISION_MAX_IMAGES=100        # LRU cap on saved image dirs")
console.log("  OMO_VISION_DIR=<system temp>/omo-vision   # where images are saved")
