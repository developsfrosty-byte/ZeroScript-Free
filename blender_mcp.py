# SPDX-License-Identifier: GPL-3.0-or-later
"""ZeroScript Blender MCP Server + Blender Installation / Add-on Helpers.

Runs as a zero-dependency stdio MCP server (JSON-RPC 2.0, protocolVersion 2024-11-05)
and also exposes importable helpers for app.py / bridge.py.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
ADDON_SRC = os.path.join(HERE, "blender_addon", "zeroscript_blender_addon.py")
ADDON_MODULE = "zeroscript_blender_addon"
DEFAULT_PORT = int(os.environ.get("ZS_BLENDER_PORT", "17615"))
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


# ── Blender Discovery, Add-on Installation & Live Probe ─────────────────────

def _user_addons_dir(version_str: str) -> str:
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return os.path.join(appdata, "Blender Foundation", "Blender", version_str, "scripts", "addons")
    if sys.platform == "darwin":
        return os.path.join(
            str(Path.home()),
            "Library", "Application Support", "Blender", version_str, "scripts", "addons",
        )
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(str(Path.home()), ".config")
    return os.path.join(xdg, "blender", version_str, "scripts", "addons")


def _extract_version_from_exe(exe_path: str) -> str:
    # Fast path from directory layout (e.g. ".../Blender 5.2/blender.exe" or ".../5.2/...")
    m = re.search(r"Blender\s+(\d+\.\d+)", exe_path, re.IGNORECASE)
    if m:
        return m.group(1)
    # Inspect sibling version folder inside install directory (e.g. "5.2")
    parent = Path(exe_path).parent
    try:
        for child in parent.iterdir():
            if child.is_dir() and re.fullmatch(r"\d+\.\d+", child.name):
                return child.name
    except OSError:
        pass
    # Fallback: query `blender --version`
    try:
        kw = {"creationflags": _NO_WINDOW} if sys.platform == "win32" else {}
        out = subprocess.run(
            [exe_path, "--version"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5, **kw,
        ).stdout
        vm = re.search(r"Blender\s+(\d+\.\d+)", out)
        if vm:
            return vm.group(1)
    except Exception:
        pass
    return "5.2"


def find_blender_installations() -> list[dict]:
    """Return detected Blender installs [{version, exe, addonsDir, addonInstalled}]."""
    seen_exes: set[str] = set()
    candidates: list[Path] = []

    if sys.platform == "win32":
        for root_env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(root_env)
            if not base:
                continue
            bf = Path(base) / "Blender Foundation"
            if bf.is_dir():
                for sub in sorted(bf.iterdir(), reverse=True):
                    exe = sub / "blender.exe"
                    if exe.is_file():
                        candidates.append(exe)
            steam = Path(base) / "Steam" / "steamapps" / "common" / "Blender" / "blender.exe"
            if steam.is_file():
                candidates.append(steam)
    elif sys.platform == "darwin":
        for app_dir in (
            Path("/Applications/Blender.app"),
            Path.home() / "Applications" / "Blender.app",
        ):
            exe = app_dir / "Contents" / "MacOS" / "Blender"
            if exe.is_file():
                candidates.append(exe)

    which_bl = shutil.which("blender")
    if which_bl:
        candidates.append(Path(which_bl))

    installs: list[dict] = []
    for cand in candidates:
        try:
            resolved = str(cand.resolve())
        except OSError:
            resolved = str(cand)
        key = resolved.lower() if sys.platform == "win32" else resolved
        if key in seen_exes or not os.path.isfile(resolved):
            continue
        seen_exes.add(key)
        ver = _extract_version_from_exe(resolved)
        addons_dir = _user_addons_dir(ver)
        addon_file = os.path.join(addons_dir, f"{ADDON_MODULE}.py")
        installs.append({
            "version": ver,
            "exe": resolved,
            "addonsDir": addons_dir,
            "addonInstalled": os.path.isfile(addon_file),
        })

    def _ver_key(item):
        parts = [int(p) if p.isdigit() else 0 for p in item["version"].split(".")]
        return tuple(parts)

    installs.sort(key=_ver_key, reverse=True)
    return installs


def install_blender_addon(auto_enable: bool = True) -> dict:
    """Copy zeroscript_blender_addon.py into detected Blender addons folders and enable it."""
    if not os.path.isfile(ADDON_SRC):
        return {"ok": False, "error": f"Add-on source missing: {ADDON_SRC}"}

    installs = find_blender_installations()
    target_dirs: list[tuple[str, str, str | None]] = []
    if installs:
        for inst in installs:
            target_dirs.append((inst["version"], inst["addonsDir"], inst["exe"]))
    else:
        # Fallback: install to existing user Blender version folders if present
        if sys.platform == "win32":
            root = Path(os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")) / "Blender Foundation" / "Blender"
        elif sys.platform == "darwin":
            root = Path.home() / "Library" / "Application Support" / "Blender"
        else:
            root = Path.home() / ".config" / "blender"
        if root.is_dir():
            for sub in sorted(root.iterdir(), reverse=True):
                if sub.is_dir() and re.fullmatch(r"\d+\.\d+", sub.name):
                    target_dirs.append((sub.name, str(sub / "scripts" / "addons"), None))

    if not target_dirs:
        return {
            "ok": False,
            "error": "No Blender installation found. Install Blender 3.6+ or copy blender_addon/zeroscript_blender_addon.py manually.",
        }

    installed_to = []
    enabled_in = []
    warnings = []
    kw = {"creationflags": _NO_WINDOW} if sys.platform == "win32" else {}

    for ver, addons_dir, exe in target_dirs:
        os.makedirs(addons_dir, exist_ok=True)
        dest = os.path.join(addons_dir, f"{ADDON_MODULE}.py")
        shutil.copy2(ADDON_SRC, dest)
        installed_to.append({"version": ver, "path": dest})
        if auto_enable and exe and os.path.isfile(exe):
            expr = (
                "import bpy; "
                f"bpy.ops.preferences.addon_enable(module='{ADDON_MODULE}'); "
                "bpy.ops.wm.save_userpref()"
            )
            try:
                proc = subprocess.run(
                    [exe, "--background", "--python-expr", expr],
                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                    timeout=25, **kw,
                )
                if proc.returncode == 0:
                    enabled_in.append(ver)
                else:
                    warnings.append(f"Blender {ver} enable exit {proc.returncode}")
            except Exception as e:
                warnings.append(f"Blender {ver} enable error: {e}")

    return {
        "ok": True,
        "installed": installed_to,
        "enabled": enabled_in,
        "warnings": warnings,
        "blenderRunning": is_blender_running(),
        "installations": find_blender_installations(),
    }


def is_blender_running() -> bool:
    """Return True if a Blender desktop process is currently running."""
    try:
        kw = {"creationflags": _NO_WINDOW} if sys.platform == "win32" else {}
        if sys.platform == "win32":
            out = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq blender.exe"],
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5, **kw,
            ).stdout
            return "blender.exe" in out.lower()
        cmd = ["pgrep", "-ix", "Blender"] if sys.platform == "darwin" else ["pgrep", "-x", "blender"]
        return subprocess.run(cmd, capture_output=True, timeout=5).returncode == 0
    except Exception:
        return False


def launch_blender(exe_path: str | None = None) -> tuple[bool, str | None]:
    target = exe_path
    if not target:
        installs = find_blender_installations()
        if not installs:
            return False, "No Blender installation detected on this PC."
        target = installs[0]["exe"]
    if not os.path.isfile(target):
        return False, f"Blender executable not found: {target}"
    try:
        subprocess.Popen([target], cwd=os.path.dirname(target))
        return True, target
    except Exception as e:
        return False, str(e)


def call_blender(action: str, params: dict | None = None, port: int | None = None, timeout: float = 90.0) -> dict:
    """Send one JSON-line request to the live Blender add-on over localhost TCP."""
    target_port = int(port or DEFAULT_PORT)
    payload = json.dumps({"action": action, "params": params or {}}, ensure_ascii=False) + "\n"
    try:
        with socket.create_connection(("127.0.0.1", target_port), timeout=timeout) as sock:
            sock.settimeout(timeout)
            sock.sendall(payload.encode("utf-8"))
            chunks = []
            while True:
                data = sock.recv(65536)
                if not data:
                    break
                chunks.append(data)
                if b"\n" in data:
                    break
            raw = b"".join(chunks).decode("utf-8", errors="replace").strip()
            if not raw:
                return {"ok": False, "error": "Empty response from Blender bridge."}
            first_line = raw.splitlines()[0]
            return json.loads(first_line)
    except (ConnectionRefusedError, TimeoutError, OSError) as e:
        return {
            "ok": False,
            "connection_error": True,
            "error": (
                f"Blender is not connected on 127.0.0.1:{target_port} ({e}). "
                "Open Blender, install/enable the 'ZeroScript AI Bridge' add-on "
                "(or click Install Add-on in the ZeroScript Desktop App > Blender tab), "
                "and ensure the bridge is started in View3D > N-panel > ZeroScript."
            ),
        }
    except Exception as e:
        return {"ok": False, "error": f"Blender bridge error: {e}"}


def probe_blender(port: int | None = None, timeout: float = 0.8) -> dict:
    installs = find_blender_installations()
    addon_installed = any(i.get("addonInstalled") for i in installs)
    res = call_blender("ping", {}, port=port, timeout=timeout)
    if res.get("ok"):
        return {
            "connected": True,
            "blenderRunning": True,
            "version": res.get("blender_version") or "",
            "scene": res.get("scene") or "Scene",
            "objects": int(res.get("object_count") or 0),
            "activeObject": res.get("active_object"),
            "filepath": res.get("filepath") or "",
            "port": int(res.get("port") or port or DEFAULT_PORT),
            "installations": installs,
            "addonInstalled": True if addon_installed else True,
        }
    return {
        "connected": False,
        "blenderRunning": is_blender_running(),
        "version": installs[0]["version"] if installs else "",
        "scene": "",
        "objects": 0,
        "activeObject": None,
        "filepath": "",
        "port": int(port or DEFAULT_PORT),
        "installations": installs,
        "addonInstalled": addon_installed,
    }


# ── MCP Tool Definitions ────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "blender_get_scene_info",
        "description": "Inspect the active Blender scene: render engine, collections, objects, transforms, materials, and mesh counts.",
        "inputSchema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "blender_get_object_info",
        "description": "Inspect a specific Blender object's world bounding box, mesh vertex/triangle counts, modifiers, and Principled BSDF materials.",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "Exact object name in Blender"}},
            "required": ["name"],
        },
    },
    {
        "name": "blender_execute_python",
        "description": "Execute arbitrary Blender Python (bpy / bmesh / mathutils) on Blender's main thread. Assign `result = ...` or print() for output.",
        "inputSchema": {
            "type": "object",
            "properties": {"code": {"type": "string", "description": "Python code using bpy, bmesh, mathutils"}},
            "required": ["code"],
        },
    },
    {
        "name": "blender_create_primitive",
        "description": "Create a primitive mesh/light/camera/empty in Blender with optional transform, smooth shading, color, and collection.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "primitive": {
                    "type": "string",
                    "enum": ["cube", "sphere", "ico_sphere", "cylinder", "cone", "torus", "plane", "grid", "monkey", "light", "camera", "empty"],
                    "description": "Primitive type",
                },
                "name": {"type": "string", "description": "Optional object name"},
                "location": {"type": "array", "items": {"type": "number"}, "description": "[x, y, z]"},
                "rotation": {"type": "array", "items": {"type": "number"}, "description": "[rx, ry, rz] in degrees"},
                "scale": {"type": "array", "items": {"type": "number"}, "description": "[sx, sy, sz]"},
                "size": {"type": "number", "description": "Size/height"},
                "radius": {"type": "number", "description": "Radius"},
                "smooth": {"type": "boolean", "description": "Apply smooth polygon shading"},
                "color": {"type": "string", "description": "Hex color like #38bdf8 or [r,g,b]"},
                "collection": {"type": "string", "description": "Optional collection name"},
            },
            "required": ["primitive"],
        },
    },
    {
        "name": "blender_transform_object",
        "description": "Move, rotate (degrees), scale, rename, reparent, hide, or delete a named Blender object.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Exact object name"},
                "location": {"type": "array", "items": {"type": "number"}},
                "rotation": {"type": "array", "items": {"type": "number"}},
                "scale": {"type": "array", "items": {"type": "number"}},
                "delta": {"type": "boolean", "description": "Apply relative to current transform"},
                "new_name": {"type": "string"},
                "parent": {"type": "string", "description": "Parent object name or empty string to unparent"},
                "hide": {"type": "boolean"},
                "delete": {"type": "boolean", "description": "Delete ONLY this named object"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "blender_set_material",
        "description": "Create or update a Principled BSDF PBR material on a Blender object.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "object_name": {"type": "string"},
                "material_name": {"type": "string"},
                "base_color": {"type": "string", "description": "Hex #rrggbb or [r,g,b]"},
                "metallic": {"type": "number"},
                "roughness": {"type": "number"},
                "emission_color": {"type": "string"},
                "emission_strength": {"type": "number"},
                "alpha": {"type": "number"},
                "transmission": {"type": "number"},
                "smooth": {"type": "boolean"},
            },
            "required": ["object_name"],
        },
    },
    {
        "name": "blender_add_modifier",
        "description": "Add and optionally configure/apply a modifier (BEVEL, SUBSURF, MIRROR, SOLIDIFY, ARRAY, DECIMATE, etc.) on an object.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "object_name": {"type": "string"},
                "modifier_type": {"type": "string", "description": "Blender modifier enum e.g. BEVEL, SUBSURF, MIRROR, SOLIDIFY, ARRAY, DECIMATE"},
                "modifier_name": {"type": "string"},
                "settings": {"type": "object", "description": "Key-value attributes on the modifier"},
                "apply": {"type": "boolean"},
            },
            "required": ["object_name", "modifier_type"],
        },
    },
    {
        "name": "blender_capture_viewport",
        "description": "Capture a live PNG preview of the Blender 3D viewport (falls back to fast camera render in headless mode).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "max_size": {"type": "integer", "description": "Max width in pixels (default 1024)"},
                "shading": {"type": "string", "enum": ["SOLID", "MATERIAL", "RENDERED", "WIREFRAME"]},
                "camera_view": {"type": "boolean"},
            },
            "required": [],
        },
    },
    {
        "name": "blender_render_scene",
        "description": "Render the Blender scene with EEVEE, CYCLES, or WORKBENCH and return a preview image.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "width": {"type": "integer"},
                "height": {"type": "integer"},
                "samples": {"type": "integer"},
                "engine": {"type": "string", "enum": ["EEVEE", "CYCLES", "WORKBENCH"]},
                "output_path": {"type": "string"},
            },
            "required": [],
        },
    },
    {
        "name": "blender_export_asset",
        "description": "Export selected or scene meshes to FBX, GLB, GLTF, or OBJ (defaults to Roblox-ready FBX in ~/ZeroScript_Exports/).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "filepath": {"type": "string", "description": "Full output path"},
                "filename": {"type": "string", "description": "Filename inside ~/ZeroScript_Exports/ if filepath omitted"},
                "format": {"type": "string", "enum": ["fbx", "glb", "gltf", "obj"]},
                "objects": {"type": "array", "items": {"type": "string"}},
                "roblox_ready": {"type": "boolean"},
            },
            "required": [],
        },
    },
    {
        "name": "blender_import_asset",
        "description": "Import a 3D asset (.fbx, .glb, .gltf, .obj, .stl) into the current Blender scene.",
        "inputSchema": {
            "type": "object",
            "properties": {"filepath": {"type": "string"}},
            "required": ["filepath"],
        },
    },
]

TOOL_TO_ACTION = {
    "blender_get_scene_info": "get_scene_info",
    "blender_get_object_info": "get_object_info",
    "blender_execute_python": "execute_python",
    "blender_create_primitive": "create_primitive",
    "blender_transform_object": "transform_object",
    "blender_set_material": "set_material",
    "blender_add_modifier": "add_modifier",
    "blender_capture_viewport": "capture_viewport",
    "blender_render_scene": "render_scene",
    "blender_export_asset": "export_asset",
    "blender_import_asset": "import_asset",
}


# ── Stdio MCP Loop ──────────────────────────────────────────────────────────

def _write_rpc(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _handle_tool_call(name: str, arguments: dict) -> dict:
    action = TOOL_TO_ACTION.get(name)
    if not action:
        return {"content": [{"type": "text", "text": f"Error: unknown Blender tool '{name}'"}], "isError": True}

    res = call_blender(action, arguments or {}, timeout=115.0)
    if not res.get("ok"):
        err = res.get("error") or "Unknown Blender error"
        tb = res.get("traceback")
        stdout = res.get("stdout")
        parts = [f"Error: {err}"]
        if stdout:
            parts.append(f"Stdout:\n{stdout}")
        if tb:
            parts.append(f"Traceback:\n{tb}")
        return {"content": [{"type": "text", "text": "\n".join(parts)}], "isError": True}

    if "image_b64" in res:
        caption = (
            f"Captured Blender {res.get('mode', 'viewport')} "
            f"({res.get('width', '?')}x{res.get('height', '?')})"
            + (f" saved to {res['filepath']}" if res.get("filepath") else "")
        )
        return {
            "content": [
                {"type": "text", "text": caption},
                {"type": "image", "data": res["image_b64"], "mimeType": res.get("mime_type", "image/png")},
            ]
        }

    return {"content": [{"type": "text", "text": json.dumps(res, indent=2, ensure_ascii=False)}]}


def serve_stdio() -> int:
    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue

        mid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}

        if method == "initialize":
            _write_rpc({
                "jsonrpc": "2.0",
                "id": mid,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "zeroscript-blender-mcp", "version": "1.8.0"},
                },
            })
        elif method == "notifications/initialized":
            continue
        elif method == "ping":
            if mid is not None:
                _write_rpc({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "tools/list":
            if mid is not None:
                _write_rpc({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            tname = params.get("name") or ""
            targs = params.get("arguments") or {}
            result = _handle_tool_call(tname, targs)
            if mid is not None:
                _write_rpc({"jsonrpc": "2.0", "id": mid, "result": result})
        elif mid is not None:
            _write_rpc({
                "jsonrpc": "2.0",
                "id": mid,
                "error": {"code": -32601, "message": f"Method not found: {method}"},
            })
    return 0


if __name__ == "__main__":
    sys.exit(serve_stdio())

