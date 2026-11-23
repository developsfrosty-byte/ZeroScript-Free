# SPDX-License-Identifier: GPL-3.0-or-later
"""ZeroScript AI Bridge add-on for Blender 3.6 / 4.x / 5.x."""

bl_info = {
    "name": "ZeroScript AI Bridge",
    "author": "ZeroScript",
    "version": (1, 8, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar (N) > ZeroScript",
    "description": "Local TCP JSON bridge allowing ZeroScript AI agents to inspect, model, shade, preview, and export assets in real time.",
    "category": "Interface",
}

import base64
import contextlib
import io
import json
import math
import os
import queue
import socket
import tempfile
import threading
import time
import traceback

import bpy
from mathutils import Euler, Vector

DEFAULT_PORT = int(os.environ.get("ZS_BLENDER_PORT", "17615"))

_server_lock = threading.Lock()
_server_socket = None
_server_thread = None
_server_running = False
_user_stopped = False
_server_port = DEFAULT_PORT
_cmd_queue: "queue.Queue[tuple]" = queue.Queue()
_timer_registered = False
_last_action_info = "Idle"
_last_action_time = ""


def _log(msg: str) -> None:
    print(f"[ZeroScript-Blender] {msg}", flush=True)


def _json_safe(val, depth: int = 0):
    if depth > 5:
        return str(val)
    if val is None or isinstance(val, (bool, int, float, str)):
        return val
    if isinstance(val, dict):
        return {str(k): _json_safe(v, depth + 1) for k, v in list(val.items())[:100]}
    if isinstance(val, (list, tuple, set)):
        return [_json_safe(v, depth + 1) for v in list(val)[:200]]
    if hasattr(val, "__iter__"):
        try:
            return [_json_safe(v, depth + 1) for v in list(val)[:50]]
        except Exception:
            pass
    return str(val)


def _parse_color(color, default=(0.8, 0.8, 0.8, 1.0)):
    if color is None:
        return tuple(default)
    if isinstance(color, str):
        s = color.strip().lstrip("#")
        if len(s) == 6:
            r = int(s[0:2], 16) / 255.0
            g = int(s[2:4], 16) / 255.0
            b = int(s[4:6], 16) / 255.0
            return (r, g, b, 1.0)
        if len(s) == 8:
            r = int(s[0:2], 16) / 255.0
            g = int(s[2:4], 16) / 255.0
            b = int(s[4:6], 16) / 255.0
            a = int(s[6:8], 16) / 255.0
            return (r, g, b, a)
        return tuple(default)
    if isinstance(color, (list, tuple)):
        vals = [float(x) for x in color]
        if any(v > 1.0 for v in vals[:3]):
            vals = [v / 255.0 if i < 3 else v for i, v in enumerate(vals)]
        if len(vals) == 3:
            return (vals[0], vals[1], vals[2], 1.0)
        if len(vals) >= 4:
            return (vals[0], vals[1], vals[2], vals[3])
    return tuple(default)


def _available_engines():
    try:
        prop = bpy.types.RenderSettings.bl_rna.properties.get("engine")
        if prop:
            return list(prop.enum_items.keys())
    except Exception:
        pass
    return ["BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"]


def _resolve_engine(requested: str = "EEVEE"):
    avail = _available_engines()
    req = (requested or "EEVEE").strip().upper()
    if req in avail:
        return req
    candidates_map = {
        "EEVEE": ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"],
        "BLENDER_EEVEE": ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"],
        "BLENDER_EEVEE_NEXT": ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"],
        "CYCLES": ["CYCLES", "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH"],
        "WORKBENCH": ["BLENDER_WORKBENCH", "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"],
    }
    for cand in candidates_map.get(req, [req]):
        if cand in avail:
            return cand
    return avail[0] if avail else "CYCLES"


def _set_bsdf_input(bsdf, names, value):
    for n in names:
        sock = bsdf.inputs.get(n)
        if sock is not None:
            sock.default_value = value
            return True
    return False


def _ensure_material(name: str, base_color=None, metallic=None, roughness=None,
                     emission_color=None, emission_strength=None, alpha=None, transmission=None):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = None
    for node in nt.nodes:
        if node.type == "BSDF_PRINCIPLED":
            bsdf = node
            break
    if bsdf is None:
        nt.nodes.clear()
        bsdf = nt.nodes.new(type="ShaderNodeBsdfPrincipled")
        out = nt.nodes.new(type="ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    if base_color is not None:
        col = _parse_color(base_color)
        _set_bsdf_input(bsdf, ("Base Color",), col)
        mat.diffuse_color = col
    if metallic is not None:
        _set_bsdf_input(bsdf, ("Metallic",), float(metallic))
    if roughness is not None:
        _set_bsdf_input(bsdf, ("Roughness",), float(roughness))
    if emission_color is not None:
        _set_bsdf_input(bsdf, ("Emission Color", "Emission"), _parse_color(emission_color))
    if emission_strength is not None:
        _set_bsdf_input(bsdf, ("Emission Strength",), float(emission_strength))
    if alpha is not None:
        _set_bsdf_input(bsdf, ("Alpha",), float(alpha))
    if transmission is not None:
        _set_bsdf_input(bsdf, ("Transmission Weight", "Transmission"), float(transmission))
    return mat


def _mesh_tri_count(mesh) -> int:
    try:
        mesh.calc_loop_triangles()
        return len(mesh.loop_triangles)
    except Exception:
        return sum(max(0, len(p.vertices) - 2) for p in mesh.polygons)


def _serialize_collection(col, depth=0):
    if depth > 4:
        return {"name": col.name, "truncated": True}
    return {
        "name": col.name,
        "objects": [o.name for o in col.objects],
        "children": [_serialize_collection(c, depth + 1) for c in col.children],
    }


def _find_view3d():
    wm = getattr(bpy.context, "window_manager", None)
    if wm is None:
        return None, None, None
    for win in wm.windows:
        screen = win.screen
        if screen is None:
            continue
        for area in screen.areas:
            if area.type == "VIEW_3D":
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                if region is not None:
                    return win, area, region
    return None, None, None


def _scene_bounds(scene):
    pts = []
    for obj in scene.objects:
        if obj.type in ("MESH", "CURVE", "SURFACE", "META", "FONT"):
            mw = obj.matrix_world
            for corner in obj.bound_box:
                pts.append(mw @ Vector(corner))
    if not pts:
        return Vector((0.0, 0.0, 0.0)), 4.0
    xs = [p.x for p in pts]
    ys = [p.y for p in pts]
    zs = [p.z for p in pts]
    vmin = Vector((min(xs), min(ys), min(zs)))
    vmax = Vector((max(xs), max(ys), max(zs)))
    center = (vmin + vmax) * 0.5
    radius = max((vmax - vmin).length * 0.5, 1.5)
    return center, radius


def _push_undo(label="ZeroScript AI"):
    try:
        bpy.ops.ed.undo_push(message=label)
    except Exception:
        pass


# ── Action Handlers (always run on Blender main thread) ─────────────────────

def _act_ping(params):
    scene = bpy.context.scene
    active = bpy.context.view_layer.objects.active if bpy.context.view_layer else None
    return {
        "ok": True,
        "blender_version": bpy.app.version_string,
        "blender_version_tuple": list(bpy.app.version),
        "scene": scene.name if scene else "",
        "object_count": len(scene.objects) if scene else 0,
        "active_object": active.name if active else None,
        "filepath": bpy.data.filepath or "",
        "port": _server_port,
    }


def _act_get_scene_info(params):
    scene = bpy.context.scene
    objects = []
    for obj in scene.objects:
        entry = {
            "name": obj.name,
            "type": obj.type,
            "location": [round(v, 4) for v in obj.location],
            "rotation_deg": [round(math.degrees(v), 2) for v in obj.rotation_euler],
            "scale": [round(v, 4) for v in obj.scale],
            "dimensions": [round(v, 4) for v in obj.dimensions],
            "visible": not obj.hide_viewport,
            "materials": [m.name for m in obj.data.materials if m] if hasattr(obj.data, "materials") and obj.data else [],
        }
        if obj.type == "MESH" and obj.data:
            entry["mesh"] = {
                "vertices": len(obj.data.vertices),
                "faces": len(obj.data.polygons),
                "triangles": _mesh_tri_count(obj.data),
            }
        objects.append(entry)

    world_bg = None
    if scene.world and scene.world.use_nodes and scene.world.node_tree:
        bg = next((n for n in scene.world.node_tree.nodes if n.type == "BACKGROUND"), None)
        if bg and "Color" in bg.inputs:
            world_bg = [round(float(c), 4) for c in bg.inputs["Color"].default_value]

    return {
        "ok": True,
        "blender_version": bpy.app.version_string,
        "scene": scene.name,
        "render_engine": scene.render.engine,
        "unit_system": scene.unit_settings.system,
        "scale_length": scene.unit_settings.scale_length,
        "frame_start": scene.frame_start,
        "frame_end": scene.frame_end,
        "fps": scene.render.fps,
        "active_camera": scene.camera.name if scene.camera else None,
        "world_background": world_bg,
        "collections": _serialize_collection(scene.collection),
        "object_count": len(objects),
        "objects": objects,
    }


def _act_get_object_info(params):
    name = (params.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "parameter 'name' is required"}
    obj = bpy.data.objects.get(name)
    if obj is None:
        return {"ok": False, "error": f"object '{name}' not found"}

    mw = obj.matrix_world
    world_bbox = [[round(v, 4) for v in (mw @ Vector(c))] for c in obj.bound_box]
    xs = [c[0] for c in world_bbox]
    ys = [c[1] for c in world_bbox]
    zs = [c[2] for c in world_bbox]

    info = {
        "ok": True,
        "name": obj.name,
        "type": obj.type,
        "location": [round(v, 4) for v in obj.location],
        "rotation_deg": [round(math.degrees(v), 2) for v in obj.rotation_euler],
        "scale": [round(v, 4) for v in obj.scale],
        "dimensions": [round(v, 4) for v in obj.dimensions],
        "parent": obj.parent.name if obj.parent else None,
        "children": [c.name for c in obj.children],
        "visible_viewport": not obj.hide_viewport,
        "visible_render": not obj.hide_render,
        "world_bbox": {
            "min": [min(xs), min(ys), min(zs)],
            "max": [max(xs), max(ys), max(zs)],
            "size": [round(max(xs) - min(xs), 4), round(max(ys) - min(ys), 4), round(max(zs) - min(zs), 4)],
        },
        "modifiers": [
            {"name": m.name, "type": m.type, "show_viewport": m.show_viewport}
            for m in obj.modifiers
        ],
    }
    if obj.type == "MESH" and obj.data:
        mesh = obj.data
        info["mesh"] = {
            "vertices": len(mesh.vertices),
            "edges": len(mesh.edges),
            "faces": len(mesh.polygons),
            "triangles": _mesh_tri_count(mesh),
            "uv_layers": [uv.name for uv in mesh.uv_layers],
            "color_attributes": [ca.name for ca in getattr(mesh, "color_attributes", [])],
        }
    if hasattr(obj.data, "materials") and obj.data:
        mats = []
        for m in obj.data.materials:
            if not m:
                continue
            md = {"name": m.name}
            if m.use_nodes and m.node_tree:
                bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
                if bsdf:
                    for key in ("Base Color", "Metallic", "Roughness", "Emission Color", "Emission", "Emission Strength"):
                        sock = bsdf.inputs.get(key)
                        if sock is not None:
                            md[key] = _json_safe(sock.default_value)
            mats.append(md)
        info["materials"] = mats
    return info


def _act_execute_python(params):
    code = params.get("code") or ""
    if not isinstance(code, str) or not code.strip():
        return {"ok": False, "error": "parameter 'code' is required"}

    import bmesh
    import mathutils

    ns = {
        "__builtins__": __builtins__,
        "bpy": bpy,
        "bmesh": bmesh,
        "mathutils": mathutils,
        "Vector": Vector,
        "Euler": Euler,
        "math": math,
        "json": json,
        "os": os,
    }
    buf_out = io.StringIO()
    buf_err = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
            exec(compile(code, "<zeroscript_blender>", "exec"), ns, ns)
        _push_undo("ZeroScript Python")
        out_str = buf_out.getvalue()
        err_str = buf_err.getvalue()
        res_val = ns.get("result", None)
        return {
            "ok": True,
            "stdout": out_str,
            "stderr": err_str,
            "result": _json_safe(res_val) if "result" in ns else None,
        }
    except Exception as e:
        tb = traceback.format_exc()
        return {
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "traceback": tb,
            "stdout": buf_out.getvalue(),
            "stderr": buf_err.getvalue(),
        }


def _act_create_primitive(params):
    kind = (params.get("primitive") or params.get("type") or "cube").strip().lower()
    name = (params.get("name") or "").strip()
    loc = tuple(float(x) for x in (params.get("location") or (0, 0, 0))[:3])
    rot_deg = tuple(float(x) for x in (params.get("rotation") or (0, 0, 0))[:3])
    rot = tuple(math.radians(a) for a in rot_deg)
    scale = params.get("scale")
    size = float(params.get("size") or 2.0)
    radius = float(params.get("radius") or 1.0)
    smooth = bool(params.get("smooth", False))
    color = params.get("color")
    col_name = (params.get("collection") or "").strip()

    before = set(bpy.data.objects.keys())
    if kind in ("cube", "box"):
        bpy.ops.mesh.primitive_cube_add(size=size, location=loc, rotation=rot)
    elif kind in ("sphere", "uv_sphere"):
        bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc, rotation=rot)
    elif kind in ("ico_sphere", "icosphere"):
        bpy.ops.mesh.primitive_ico_sphere_add(radius=radius, location=loc, rotation=rot)
    elif kind == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=size, location=loc, rotation=rot)
    elif kind == "cone":
        bpy.ops.mesh.primitive_cone_add(radius1=radius, depth=size, location=loc, rotation=rot)
    elif kind == "torus":
        bpy.ops.mesh.primitive_torus_add(location=loc, rotation=rot)
    elif kind == "plane":
        bpy.ops.mesh.primitive_plane_add(size=size, location=loc, rotation=rot)
    elif kind == "grid":
        bpy.ops.mesh.primitive_grid_add(size=size, location=loc, rotation=rot)
    elif kind in ("monkey", "suzanne"):
        bpy.ops.mesh.primitive_monkey_add(size=size, location=loc, rotation=rot)
    elif kind == "light":
        ltype = (params.get("light_type") or "POINT").upper()
        bpy.ops.object.light_add(type=ltype, location=loc, rotation=rot)
    elif kind == "camera":
        bpy.ops.object.camera_add(location=loc, rotation=rot)
    elif kind == "empty":
        bpy.ops.object.empty_add(type="PLAIN_AXES", location=loc, rotation=rot)
    else:
        return {"ok": False, "error": f"unknown primitive '{kind}'"}

    obj = bpy.context.active_object
    if obj is None or obj.name in before:
        created = [bpy.data.objects[k] for k in bpy.data.objects.keys() if k not in before]
        obj = created[0] if created else obj
    if obj is None:
        return {"ok": False, "error": "failed to locate created object"}

    if name:
        obj.name = name
    if scale and isinstance(scale, (list, tuple)) and len(scale) >= 3:
        obj.scale = (float(scale[0]), float(scale[1]), float(scale[2]))

    if obj.type == "MESH" and obj.data:
        if smooth:
            for p in obj.data.polygons:
                p.use_smooth = True
        if color is not None:
            mat = _ensure_material(f"{obj.name}_Mat", base_color=color)
            if len(obj.data.materials):
                obj.data.materials[0] = mat
            else:
                obj.data.materials.append(mat)

    if col_name:
        target_col = bpy.data.collections.get(col_name)
        if target_col is None:
            target_col = bpy.data.collections.new(col_name)
            bpy.context.scene.collection.children.link(target_col)
        for c in list(obj.users_collection):
            c.objects.unlink(obj)
        target_col.objects.link(obj)

    _push_undo("ZeroScript Create Primitive")
    return {
        "ok": True,
        "name": obj.name,
        "type": obj.type,
        "location": [round(v, 4) for v in obj.location],
        "rotation_deg": [round(math.degrees(v), 2) for v in obj.rotation_euler],
        "scale": [round(v, 4) for v in obj.scale],
    }


def _act_transform_object(params):
    name = (params.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "parameter 'name' is required"}
    obj = bpy.data.objects.get(name)
    if obj is None:
        return {"ok": False, "error": f"object '{name}' not found"}

    if params.get("delete") is True:
        bpy.data.objects.remove(obj, do_unlink=True)
        _push_undo("ZeroScript Delete Object")
        return {"ok": True, "deleted": name}

    delta = bool(params.get("delta", False))
    if params.get("location") is not None:
        loc = [float(x) for x in params["location"][:3]]
        if delta:
            obj.location = (obj.location.x + loc[0], obj.location.y + loc[1], obj.location.z + loc[2])
        else:
            obj.location = tuple(loc)
    if params.get("rotation") is not None:
        rot = [math.radians(float(x)) for x in params["rotation"][:3]]
        if delta:
            obj.rotation_euler = (
                obj.rotation_euler.x + rot[0],
                obj.rotation_euler.y + rot[1],
                obj.rotation_euler.z + rot[2],
            )
        else:
            obj.rotation_euler = tuple(rot)
    if params.get("scale") is not None:
        sc = [float(x) for x in params["scale"][:3]]
        if delta:
            obj.scale = (obj.scale.x * sc[0], obj.scale.y * sc[1], obj.scale.z * sc[2])
        else:
            obj.scale = tuple(sc)
    if params.get("new_name"):
        obj.name = str(params["new_name"]).strip()
    if "parent" in params:
        pname = params.get("parent")
        if not pname:
            obj.parent = None
        else:
            pobj = bpy.data.objects.get(str(pname))
            if pobj is None:
                return {"ok": False, "error": f"parent object '{pname}' not found"}
            obj.parent = pobj
    if "hide" in params and params.get("hide") is not None:
        hide = bool(params["hide"])
        obj.hide_viewport = hide
        obj.hide_render = hide

    _push_undo("ZeroScript Transform Object")
    return {
        "ok": True,
        "name": obj.name,
        "location": [round(v, 4) for v in obj.location],
        "rotation_deg": [round(math.degrees(v), 2) for v in obj.rotation_euler],
        "scale": [round(v, 4) for v in obj.scale],
    }


def _act_set_material(params):
    obj_name = (params.get("object_name") or params.get("name") or "").strip()
    if not obj_name:
        return {"ok": False, "error": "parameter 'object_name' is required"}
    obj = bpy.data.objects.get(obj_name)
    if obj is None:
        return {"ok": False, "error": f"object '{obj_name}' not found"}
    if not hasattr(obj.data, "materials") or obj.data is None:
        return {"ok": False, "error": f"object '{obj_name}' ({obj.type}) does not support materials"}

    mat_name = (params.get("material_name") or f"{obj.name}_Mat").strip()
    mat = _ensure_material(
        mat_name,
        base_color=params.get("base_color"),
        metallic=params.get("metallic"),
        roughness=params.get("roughness"),
        emission_color=params.get("emission_color"),
        emission_strength=params.get("emission_strength"),
        alpha=params.get("alpha"),
        transmission=params.get("transmission"),
    )
    if len(obj.data.materials) == 0:
        obj.data.materials.append(mat)
    else:
        obj.data.materials[0] = mat

    if params.get("smooth") is not None and obj.type == "MESH":
        sm = bool(params["smooth"])
        for p in obj.data.polygons:
            p.use_smooth = sm

    _push_undo("ZeroScript Set Material")
    return {"ok": True, "object": obj.name, "material": mat.name}


def _act_add_modifier(params):
    obj_name = (params.get("object_name") or params.get("name") or "").strip()
    mtype = (params.get("modifier_type") or params.get("type") or "").strip().upper()
    if not obj_name or not mtype:
        return {"ok": False, "error": "parameters 'object_name' and 'modifier_type' are required"}
    obj = bpy.data.objects.get(obj_name)
    if obj is None:
        return {"ok": False, "error": f"object '{obj_name}' not found"}

    mname = (params.get("modifier_name") or mtype.title()).strip()
    mod = obj.modifiers.new(name=mname, type=mtype)
    settings = params.get("settings") or {}
    if isinstance(settings, dict):
        for k, v in settings.items():
            if hasattr(mod, k):
                try:
                    if k == "object" and isinstance(v, str):
                        v = bpy.data.objects.get(v)
                    setattr(mod, k, v)
                except Exception:
                    pass

    applied = False
    if params.get("apply") is True:
        bpy.context.view_layer.objects.active = obj
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
            applied = True
        except Exception as e:
            return {"ok": False, "error": f"added modifier '{mod.name}' but failed to apply: {e}"}

    _push_undo("ZeroScript Add Modifier")
    return {"ok": True, "object": obj.name, "modifier": mname, "type": mtype, "applied": applied}


def _point_camera_at(cam_obj, target: Vector):
    direction = target - cam_obj.location
    rot_quat = direction.to_track_quat("-Z", "Y")
    cam_obj.rotation_euler = rot_quat.to_euler()


def _render_to_b64(scene, width, height, engine=None, samples=None,
                   use_opengl=False, shading=None, camera_view=False, out_path=None):
    orig_fp = scene.render.filepath
    orig_fmt = scene.render.image_settings.file_format
    orig_rx = scene.render.resolution_x
    orig_ry = scene.render.resolution_y
    orig_rp = scene.render.resolution_percentage
    orig_eng = scene.render.engine
    orig_cam = scene.camera

    temp_file = None
    temp_cam = None
    win, area, region = _find_view3d()
    prev_shading = None
    prev_persp = None

    try:
        if out_path:
            target_path = os.path.abspath(os.path.expanduser(out_path))
            os.makedirs(os.path.dirname(target_path), exist_ok=True)
        else:
            fd, temp_file = tempfile.mkstemp(prefix="zs_blender_", suffix=".png")
            os.close(fd)
            target_path = temp_file

        scene.render.filepath = target_path
        scene.render.image_settings.file_format = "PNG"
        scene.render.resolution_x = int(width)
        scene.render.resolution_y = int(height)
        scene.render.resolution_percentage = 100

        mode = "render"
        if use_opengl and area is not None and region is not None and win is not None:
            space = area.spaces.active
            if shading and space and hasattr(space, "shading"):
                prev_shading = space.shading.type
                if shading in ("WIREFRAME", "SOLID", "MATERIAL", "RENDERED"):
                    space.shading.type = shading
            if camera_view and space and hasattr(space, "region_3d") and scene.camera:
                prev_persp = space.region_3d.view_perspective
                space.region_3d.view_perspective = "CAMERA"
            with bpy.context.temp_override(window=win, area=area, region=region):
                bpy.ops.render.opengl(write_still=True)
            mode = "viewport"
        else:
            chosen_eng = _resolve_engine(engine or "WORKBENCH")
            scene.render.engine = chosen_eng
            if samples is not None:
                if chosen_eng == "CYCLES" and hasattr(scene, "cycles"):
                    scene.cycles.samples = int(samples)
                elif hasattr(scene, "eevee") and hasattr(scene.eevee, "taa_render_samples"):
                    scene.eevee.taa_render_samples = int(samples)

            if scene.camera is None:
                center, radius = _scene_bounds(scene)
                cam_data = bpy.data.cameras.new("_ZS_TempCam")
                temp_cam = bpy.data.objects.new("_ZS_TempCam", cam_data)
                scene.collection.objects.link(temp_cam)
                dist = max(radius * 2.6, 4.5)
                temp_cam.location = center + Vector((dist * 0.72, -dist * 0.72, dist * 0.55))
                _point_camera_at(temp_cam, center)
                scene.camera = temp_cam

            bpy.ops.render.render(write_still=True)

        with open(target_path, "rb") as f:
            raw = f.read()
        return {
            "ok": True,
            "image_b64": base64.b64encode(raw).decode("ascii"),
            "mime_type": "image/png",
            "width": int(width),
            "height": int(height),
            "mode": mode,
            "filepath": target_path if out_path else None,
        }
    finally:
        if prev_shading is not None and area is not None:
            try:
                area.spaces.active.shading.type = prev_shading
            except Exception:
                pass
        if prev_persp is not None and area is not None:
            try:
                area.spaces.active.region_3d.view_perspective = prev_persp
            except Exception:
                pass
        scene.render.filepath = orig_fp
        scene.render.image_settings.file_format = orig_fmt
        scene.render.resolution_x = orig_rx
        scene.render.resolution_y = orig_ry
        scene.render.resolution_percentage = orig_rp
        scene.render.engine = orig_eng
        scene.camera = orig_cam
        if temp_cam is not None:
            try:
                cam_data = temp_cam.data
                bpy.data.objects.remove(temp_cam, do_unlink=True)
                if cam_data and cam_data.users == 0:
                    bpy.data.cameras.remove(cam_data)
            except Exception:
                pass
        if temp_file and os.path.isfile(temp_file):
            try:
                os.remove(temp_file)
            except Exception:
                pass


def _act_capture_viewport(params):
    scene = bpy.context.scene
    max_size = max(256, min(1920, int(params.get("max_size") or 1024)))
    w = max_size
    h = int(round(max_size * 9 / 16))
    shading = (params.get("shading") or "").strip().upper() or None
    camera_view = bool(params.get("camera_view", False))
    use_opengl = not bpy.app.background and _find_view3d()[1] is not None
    return _render_to_b64(
        scene,
        w,
        h,
        engine="WORKBENCH" if not use_opengl else None,
        use_opengl=use_opengl,
        shading=shading,
        camera_view=camera_view,
    )


def _act_render_scene(params):
    scene = bpy.context.scene
    w = max(128, min(3840, int(params.get("width") or 960)))
    h = max(128, min(2160, int(params.get("height") or 540)))
    samples = int(params.get("samples") or 32)
    engine = (params.get("engine") or "EEVEE").strip().upper()
    out_path = params.get("output_path")
    return _render_to_b64(
        scene,
        w,
        h,
        engine=engine,
        samples=samples,
        use_opengl=False,
        out_path=out_path,
    )


def _act_export_asset(params):
    scene = bpy.context.scene
    raw_fp = (params.get("filepath") or "").strip()
    fmt = (params.get("format") or "").strip().lower().lstrip(".")
    if not raw_fp:
        fname = (params.get("filename") or "zeroscript_export").strip()
        if not fmt:
            fmt = "fbx"
        if not fname.lower().endswith(f".{fmt}"):
            fname = f"{fname}.{fmt}"
        export_dir = os.path.join(os.path.expanduser("~"), "ZeroScript_Exports")
        os.makedirs(export_dir, exist_ok=True)
        filepath = os.path.join(export_dir, fname)
    else:
        filepath = os.path.abspath(os.path.expanduser(raw_fp))
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        if not fmt:
            fmt = os.path.splitext(filepath)[1].lower().lstrip(".") or "fbx"

    obj_names = params.get("objects")
    if isinstance(obj_names, list) and obj_names:
        targets = [bpy.data.objects.get(str(n)) for n in obj_names]
        targets = [o for o in targets if o is not None]
        if not targets:
            return {"ok": False, "error": "none of the specified objects were found"}
    else:
        targets = [o for o in scene.objects if o.type in ("MESH", "ARMATURE", "EMPTY")]
        if not targets:
            targets = list(scene.objects)

    if not targets:
        return {"ok": False, "error": "scene has no objects to export"}

    roblox_ready = bool(params.get("roblox_ready", True))
    prev_sel = [o for o in scene.objects if o.select_get()]
    prev_active = bpy.context.view_layer.objects.active
    try:
        bpy.ops.object.select_all(action="DESELECT")
        for o in targets:
            o.select_set(True)
        bpy.context.view_layer.objects.active = targets[0]

        if roblox_ready:
            try:
                bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
            except Exception:
                pass

        if fmt == "fbx":
            bpy.ops.export_scene.fbx(
                filepath=filepath,
                use_selection=True,
                apply_scale_options="FBX_SCALE_ALL",
                path_mode="COPY",
                embed_textures=True,
                bake_space_transform=True,
            )
        elif fmt in ("glb", "gltf"):
            efmt = "GLB" if fmt == "glb" else "GLTF_SEPARATE"
            bpy.ops.export_scene.gltf(
                filepath=filepath,
                use_selection=True,
                export_format=efmt,
                export_apply=True,
            )
        elif fmt == "obj":
            if hasattr(bpy.ops.wm, "obj_export"):
                bpy.ops.wm.obj_export(filepath=filepath, export_selected_objects=True)
            else:
                bpy.ops.export_scene.obj(filepath=filepath, use_selection=True)
        else:
            return {"ok": False, "error": f"unsupported export format '{fmt}' (use fbx, glb, gltf, or obj)"}
    finally:
        try:
            bpy.ops.object.select_all(action="DESELECT")
            for o in prev_sel:
                if o.name in bpy.data.objects:
                    o.select_set(True)
            if prev_active and prev_active.name in bpy.data.objects:
                bpy.context.view_layer.objects.active = prev_active
        except Exception:
            pass

    total_tris = sum(_mesh_tri_count(o.data) for o in targets if o.type == "MESH" and o.data)
    size_kb = round(os.path.getsize(filepath) / 1024.0, 2) if os.path.isfile(filepath) else 0.0
    res = {
        "ok": True,
        "filepath": filepath,
        "format": fmt,
        "size_kb": size_kb,
        "objects": [o.name for o in targets],
        "triangles": total_tris,
    }
    if total_tris > 10000:
        res["roblox_warning"] = f"Mesh has {total_tris} triangles (Roblox MeshPart limit is 10,000 tris per mesh; consider splitting or decimating)."
    return res


def _act_import_asset(params):
    raw_fp = (params.get("filepath") or "").strip()
    if not raw_fp:
        return {"ok": False, "error": "parameter 'filepath' is required"}
    filepath = os.path.abspath(os.path.expanduser(raw_fp))
    if not os.path.isfile(filepath):
        return {"ok": False, "error": f"file not found: {filepath}"}

    ext = os.path.splitext(filepath)[1].lower().lstrip(".")
    before = set(bpy.data.objects.keys())
    if ext == "fbx":
        bpy.ops.import_scene.fbx(filepath=filepath)
    elif ext in ("glb", "gltf"):
        bpy.ops.import_scene.gltf(filepath=filepath)
    elif ext == "obj":
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=filepath)
        else:
            bpy.ops.import_scene.obj(filepath=filepath)
    elif ext == "stl":
        if hasattr(bpy.ops.wm, "stl_import"):
            bpy.ops.wm.stl_import(filepath=filepath)
        else:
            bpy.ops.import_mesh.stl(filepath=filepath)
    else:
        return {"ok": False, "error": f"unsupported import format '.{ext}'"}

    imported = [k for k in bpy.data.objects.keys() if k not in before]
    _push_undo("ZeroScript Import Asset")
    return {"ok": True, "filepath": filepath, "imported_objects": imported}


ACTION_MAP = {
    "ping": _act_ping,
    "get_scene_info": _act_get_scene_info,
    "get_object_info": _act_get_object_info,
    "execute_python": _act_execute_python,
    "create_primitive": _act_create_primitive,
    "transform_object": _act_transform_object,
    "set_material": _act_set_material,
    "add_modifier": _act_add_modifier,
    "capture_viewport": _act_capture_viewport,
    "render_scene": _act_render_scene,
    "export_asset": _act_export_asset,
    "import_asset": _act_import_asset,
}


def _dispatch(req: dict) -> dict:
    global _last_action_info, _last_action_time
    action = (req.get("action") or "").strip()
    params = req.get("params") or {}
    fn = ACTION_MAP.get(action)
    if fn is None:
        return {"ok": False, "error": f"unknown action '{action}'"}
    _last_action_info = action
    _last_action_time = time.strftime("%H:%M:%S")
    try:
        res = fn(params)
        return res if isinstance(res, dict) else {"ok": True, "result": _json_safe(res)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()}


def _process_queue():
    while not _cmd_queue.empty():
        try:
            req, done_evt, box = _cmd_queue.get_nowait()
        except queue.Empty:
            break
        try:
            box["res"] = _dispatch(req)
        except Exception as e:
            box["res"] = {"ok": False, "error": str(e)}
        finally:
            done_evt.set()
    return 0.03 if _server_running else None


def _handle_client(conn: socket.socket):
    conn.settimeout(120.0)
    buf = b""
    try:
        while _server_running:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                raw = line.decode("utf-8", errors="replace").strip()
                if not raw:
                    continue
                try:
                    req = json.loads(raw)
                except Exception as e:
                    resp = {"ok": False, "error": f"invalid JSON: {e}"}
                else:
                    done = threading.Event()
                    box = {}
                    _cmd_queue.put((req, done, box))
                    if done.wait(timeout=115.0):
                        resp = box.get("res") or {"ok": False, "error": "empty response"}
                    else:
                        resp = {"ok": False, "error": "Blender main thread timed out executing command"}
                conn.sendall((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _accept_loop():
    global _server_running
    while _server_running and _server_socket is not None:
        try:
            conn, _ = _server_socket.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=_handle_client, args=(conn,), daemon=True).start()


def start_bridge(port: int = None) -> tuple:
    global _server_socket, _server_thread, _server_running, _server_port, _timer_registered
    with _server_lock:
        if _server_running:
            return True, f"Already running on 127.0.0.1:{_server_port}"
        target_port = int(port or DEFAULT_PORT)
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            srv.bind(("127.0.0.1", target_port))
            srv.listen(8)
            srv.settimeout(0.5)
        except OSError as e:
            try:
                srv.close()
            except Exception:
                pass
            return False, f"Could not bind port {target_port}: {e}"

        _server_socket = srv
        _server_port = target_port
        _server_running = True
        _server_thread = threading.Thread(target=_accept_loop, daemon=True)
        _server_thread.start()

        if not _timer_registered:
            try:
                if not bpy.app.timers.is_registered(_process_queue):
                    bpy.app.timers.register(_process_queue, first_interval=0.03, persistent=True)
                _timer_registered = True
            except Exception:
                pass
        _log(f"Bridge listening on 127.0.0.1:{_server_port}")
        return True, f"Listening on 127.0.0.1:{_server_port}"


def stop_bridge() -> None:
    global _server_socket, _server_running, _timer_registered
    with _server_lock:
        _server_running = False
        if _server_socket is not None:
            try:
                _server_socket.close()
            except Exception:
                pass
            _server_socket = None
        if _timer_registered:
            try:
                if bpy.app.timers.is_registered(_process_queue):
                    bpy.app.timers.unregister(_process_queue)
            except Exception:
                pass
            _timer_registered = False
        _log("Bridge stopped")


# ── Blender N-Panel UI & Operators ──────────────────────────────────────────

class ZEROSCRIPT_OT_StartBridge(bpy.types.Operator):
    bl_idname = "zeroscript.start_bridge"
    bl_label = "Start ZeroScript Bridge"
    bl_description = "Start the local ZeroScript AI TCP bridge"

    def execute(self, context):
        global _user_stopped
        _user_stopped = False
        port = getattr(context.scene, "zs_bridge_port", DEFAULT_PORT)
        ok, msg = start_bridge(port)
        self.report({"INFO"} if ok else {"ERROR"}, msg)
        return {"FINISHED"} if ok else {"CANCELLED"}


class ZEROSCRIPT_OT_StopBridge(bpy.types.Operator):
    bl_idname = "zeroscript.stop_bridge"
    bl_label = "Stop ZeroScript Bridge"
    bl_description = "Stop the local ZeroScript AI TCP bridge"

    def execute(self, context):
        global _user_stopped
        _user_stopped = True
        stop_bridge()
        self.report({"INFO"}, "ZeroScript bridge stopped")
        return {"FINISHED"}


class ZEROSCRIPT_PT_BridgePanel(bpy.types.Panel):
    bl_label = "ZeroScript AI Bridge"
    bl_idname = "ZEROSCRIPT_PT_BridgePanel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "ZeroScript"

    def draw(self, context):
        layout = self.layout
        box = layout.box()
        if _server_running:
            box.label(text=f"Online · 127.0.0.1:{_server_port}", icon="CHECKMARK")
            box.operator("zeroscript.stop_bridge", icon="PAUSE")
        else:
            box.label(text="Offline", icon="ERROR")
            box.operator("zeroscript.start_bridge", icon="PLAY")

        layout.prop(context.scene, "zs_bridge_port", text="Port")
        if _last_action_time:
            layout.label(text=f"Last: {_last_action_info} ({_last_action_time})", icon="TIME")


def _ensure_started():
    if not bpy.app.background and not _user_stopped and not _server_running:
        start_bridge(DEFAULT_PORT)
    return None


@bpy.app.handlers.persistent
def _on_load_post(_dummy=None):
    if not bpy.app.background and not _user_stopped:
        if not _server_running:
            start_bridge(DEFAULT_PORT)
        elif not bpy.app.timers.is_registered(_process_queue):
            bpy.app.timers.register(_process_queue, first_interval=0.03, persistent=True)


CLASSES = (
    ZEROSCRIPT_OT_StartBridge,
    ZEROSCRIPT_OT_StopBridge,
    ZEROSCRIPT_PT_BridgePanel,
)


def register():
    global _user_stopped
    _user_stopped = False
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.zs_bridge_port = bpy.props.IntProperty(
        name="ZeroScript Bridge Port",
        default=DEFAULT_PORT,
        min=1024,
        max=65535,
    )
    if _on_load_post not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_on_load_post)
    if not bpy.app.background:
        start_bridge(DEFAULT_PORT)
        bpy.app.timers.register(_ensure_started, first_interval=0.5, persistent=True)


def unregister():
    try:
        while _on_load_post in bpy.app.handlers.load_post:
            bpy.app.handlers.load_post.remove(_on_load_post)
    except Exception:
        pass
    stop_bridge()
    if hasattr(bpy.types.Scene, "zs_bridge_port"):
        del bpy.types.Scene.zs_bridge_port
    for cls in reversed(CLASSES):
        try:
            bpy.utils.unregister_class(cls)
        except Exception:
            pass


if __name__ == "__main__":
    register()

