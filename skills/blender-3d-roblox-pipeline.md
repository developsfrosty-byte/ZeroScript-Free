---
id: blender-3d-roblox-pipeline
name: "Blender 3D Modeling & Roblox Pipeline"
category: Blender
tagline: "Procedural bmesh & Blender 4/5 Python craft, PBR materials, viewport self-review, and <10k-tri Roblox FBX/GLB export."
enabled: true
mode: auto
builtin: true
---
# AAA Blender 3D Modeling & Roblox Export Playbook

Follow these rules whenever creating, editing, shading, rendering, or exporting 3D assets in **Blender** (including Blender 4.x and 5.x) via the `blender` MCP server.

## 1. Blender 4.x / 5.x API Safety Rules
- **NEVER use `mesh.use_auto_smooth`** — it was removed in Blender 4.1+. Set smooth shading per polygon (`for p in mesh.polygons: p.use_smooth = True`) or add a `WEIGHTED_NORMAL` / `EDGE_SPLIT` modifier.
- **Check Principled BSDF socket names defensively**: in Blender 4.0+, `Transmission` became `Transmission Weight`, `Emission` became `Emission Color`, and `Specular` became `Specular IOR Level`. Prefer `blender_set_material` or check `if "Name" in bsdf.inputs`.
- **Use `bpy.ops.wm.obj_export` / `wm.obj_import`** on Blender 4/5 (fallback to `export_scene.obj` on 3.x), and inspect `bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items.keys()` before setting `scene.render.engine` (`BLENDER_EEVEE_NEXT` vs `BLENDER_EEVEE`).
- **Always use `bmesh` for clean custom geometry** (`bm.normal_update()`, `bmesh.ops.recalc_face_normals(bm, faces=bm.faces)`, `bm.to_mesh(mesh)`, `bm.free()`).

## 2. Clean Hard-Surface & Stylized Modeling Craft
- Build multi-part hero props with real silhouettes: **primary massing** -> **beveled edges (`BEVEL` modifier with `segments=2..3`, `limit_method='ANGLE'`)** -> **secondary trim, insets, bolts, or handles** -> **clean origin at base (`z = 0`)**.
- Keep face normals consistent (`recalc_face_normals`) so Roblox Studio does not render inside-out faces (`DoubleSided` should not be a crutch).
- Always run **Smart UV Project** (`bpy.ops.uv.smart_project`) or explicit seams before exporting textured/PBR meshes.

## 3. Roblox Studio Export Readiness
- **Triangle budget**: Roblox `MeshPart` has a **10,000-triangle** limit per single mesh. Keep props under 2k–6k tris and hero assets under 9.5k tris (or split into named sub-meshes before export).
- **Scale & transforms**: 1 Blender meter ≈ 3.57 Roblox studs (or author directly at clean meters and apply scale `transform_apply(location=False, rotation=True, scale=True)` before exporting).
- **Export cleanly**: call `blender_export_asset` with `format: "fbx"` (or `"glb"`) and `roblox_ready: true`. It writes into `~/ZeroScript_Exports/` and reports exact triangle counts and file paths.

## 4. Visual Self-Review Loop
- After creating or modifying a model/material, call `blender_capture_viewport` (with `shading: "MATERIAL"` or `"SOLID"`) to inspect proportions, normals, silhouette, and colors before finalizing.
- When running `blender_execute_python`, prefer the fenced `###BLENDER### ... ###END_BLENDER###` block so you never have to escape quotes inside JSON.

