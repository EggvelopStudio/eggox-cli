// Run from the monorepo with node --experimental-strip-types --test.
import test from "node:test"
import assert from "node:assert/strict"
import { encodeBlueprint, decodeBlueprint, BLUEPRINT_RULES } from "../bin/eggox.mjs"
import { serialize, deserialize, FRAME_TICK_MS, MAX_ITEM_FRAMES, ANIMATION_CYCLE_FRAMES, MAX_LAYERS } from "../../client/src/voxel/format.ts"

test("CLI binary is the canonical editor format, including visible composites and hidden layers", () => {
  const doc = { format: "eggox-blueprint", version: 1, display_name: "Layers", item_type: "solid",
    size: { x: 2, y: 2, z: 2 }, palette: ["#000000", "#ff0000", "#00ff00"], rotations: 4,
    frames: [{ layers: [
      { name: "body", visible: true, voxels: [[1, 0, 0, 1], [0, 0, 1, 1]] },
      { name: "top", visible: true, voxels: [[1, 0, 0, 2]] },
      { name: "hidden", visible: false, voxels: [[1, 0, 0, 1], [1, 1, 1, 2]] },
    ], activeLayer: 2 }] }
  const packed = encodeBlueprint(doc)
  const bytes = Buffer.from(packed.voxel_source_b64, "base64")
  const editor = deserialize(bytes, { layers: true })
  assert.deepEqual([...editor.frames[0].voxels], [0, 2, 0, 0, 1, 0, 0, 0])
  assert.equal(editor.frames[0].layers[2].voxels[7], 2)
  assert.deepEqual(Buffer.from(serialize(editor)), bytes)
  const returned = decodeBlueprint({ ...packed, voxel_source_b64: Buffer.from(serialize(editor)).toString("base64") })
  assert.deepEqual(returned.frames, doc.frames.map(f => ({ ...f, duration_ms: 100 })))
  assert.equal(BLUEPRINT_RULES.frame_tick_ms, FRAME_TICK_MS)
  assert.equal(BLUEPRINT_RULES.max_frames, MAX_ITEM_FRAMES)
  assert.equal(BLUEPRINT_RULES.world_cycle_frames, ANIMATION_CYCLE_FRAMES)
  assert.equal(BLUEPRINT_RULES.max_layers, MAX_LAYERS)
})
