# SPDX-License-Identifier: GPL-3.0-or-later
"""ZeroScript Skills & App Settings manager (pure Python stdlib)."""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SKILLS_DIR = os.path.join(HERE, "skills")
SETTINGS_PATH = os.path.join(HERE, "app_settings.json")

BUILTIN_ORDER = {
    "ui-craftsmanship": 0,
    "building-architecture": 1,
    "cutscenes-cinematics": 2,
}

VALID_CATEGORIES = ("UI", "Building", "Cutscenes", "Custom")
VALID_MODES = ("auto", "always")


def _ensure_skills_dir():
    os.makedirs(SKILLS_DIR, exist_ok=True)


def _slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", str(text or "").strip().lower()).strip("-")
    return slug[:64] or "custom-skill"


def _norm_key(text):
    return re.sub(r"[^a-z0-9]+", "", str(text or "").strip().lower())


def _parse_bool(val, default=True):
    if isinstance(val, bool):
        return val
    s = str(val or "").strip().lower()
    if s in ("true", "1", "yes", "on"):
        return True
    if s in ("false", "0", "no", "off"):
        return False
    return default


def _unquote(val):
    s = str(val or "").strip()
    if len(s) >= 2 and ((s[0] == '"' and s[-1] == '"') or (s[0] == "'" and s[-1] == "'")):
        inner = s[1:-1]
        if s[0] == '"':
            inner = inner.replace('\\"', '"').replace("\\\\", "\\")
        return inner
    return s


def _quote(val):
    s = str(val or "").replace("\r", " ").replace("\n", " ").strip()
    if not s or any(ch in s for ch in (":", "#", '"', "'")) or s.startswith(" ") or s.endswith(" "):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def _parse_skill_file(path, include_content=True):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read()

    raw_norm = raw.replace("\r\n", "\n")
    meta = {}
    body = raw_norm

    if raw_norm.startswith("---\n"):
        end_idx = raw_norm.find("\n---\n", 4)
        if end_idx == -1 and raw_norm.rstrip().endswith("\n---"):
            end_idx = raw_norm.rfind("\n---")
            fm_text = raw_norm[4:end_idx]
            body = ""
        elif end_idx != -1:
            fm_text = raw_norm[4:end_idx]
            body = raw_norm[end_idx + 5:]
        else:
            fm_text = ""

        for line in fm_text.split("\n"):
            line = line.strip()
            if not line or line.startswith("#") or ":" not in line:
                continue
            k, v = line.split(":", 1)
            meta[k.strip().lower()] = _unquote(v)

    fname_id = os.path.splitext(os.path.basename(path))[0]
    sid = _slugify(meta.get("id") or fname_id)
    name = (meta.get("name") or sid.replace("-", " ").title()).strip()
    category = (meta.get("category") or "Custom").strip()
    if category not in VALID_CATEGORIES:
        cat_match = next((c for c in VALID_CATEGORIES if c.lower() == category.lower()), None)
        category = cat_match or category or "Custom"
    tagline = (meta.get("tagline") or "").strip()
    enabled = _parse_bool(meta.get("enabled"), default=True)
    mode = (meta.get("mode") or "auto").strip().lower()
    if mode not in VALID_MODES:
        mode = "auto"
    builtin = _parse_bool(meta.get("builtin"), default=(sid in BUILTIN_ORDER))
    body_clean = body.lstrip("\n")

    skill = {
        "id": sid,
        "name": name,
        "category": category,
        "tagline": tagline,
        "enabled": enabled,
        "mode": mode,
        "builtin": builtin,
        "chars": len(body_clean),
        "file": os.path.basename(path),
    }
    if include_content:
        skill["content"] = body_clean
    return skill


def _serialize_skill(skill):
    lines = [
        "---",
        f"id: {_quote(skill['id'])}",
        f"name: {_quote(skill['name'])}",
        f"category: {_quote(skill['category'])}",
        f"tagline: {_quote(skill.get('tagline', ''))}",
        f"enabled: {'true' if skill.get('enabled', True) else 'false'}",
        f"mode: {skill.get('mode', 'auto') if skill.get('mode') in VALID_MODES else 'auto'}",
        f"builtin: {'true' if skill.get('builtin', False) else 'false'}",
        "---",
        "",
    ]
    body = str(skill.get("content") or "").replace("\r\n", "\n").lstrip("\n")
    if body and not body.endswith("\n"):
        body += "\n"
    return "\n".join(lines) + body


def _atomic_write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def list_skills(include_content=True):
    _ensure_skills_dir()
    skills = []
    for entry in os.listdir(SKILLS_DIR):
        if not entry.lower().endswith(".md"):
            continue
        full = os.path.join(SKILLS_DIR, entry)
        if not os.path.isfile(full):
            continue
        try:
            skills.append(_parse_skill_file(full, include_content=include_content))
        except Exception:
            continue

    skills.sort(key=lambda s: (
        0 if s["id"] in BUILTIN_ORDER else 1,
        BUILTIN_ORDER.get(s["id"], 999),
        s["name"].lower(),
    ))
    return skills


def list_summary():
    out = []
    for s in list_skills(include_content=True):
        item = {
            "id": s["id"],
            "name": s["name"],
            "category": s["category"],
            "tagline": s["tagline"],
            "enabled": s["enabled"],
            "mode": s["mode"],
            "builtin": s["builtin"],
            "chars": s["chars"],
        }
        if s["enabled"] and s["mode"] == "always":
            item["content"] = s.get("content", "")
        out.append(item)
    return out


def get_skill(skill_id):
    q = _norm_key(skill_id)
    if not q:
        return None
    skills = list_skills(include_content=True)
    # 1. Exact id or name
    for s in skills:
        if _norm_key(s["id"]) == q or _norm_key(s["name"]) == q:
            return s
    # 2. Exact category match
    for s in skills:
        if _norm_key(s["category"]) == q:
            return s
    # 3. Substring / prefix match
    for s in skills:
        if q in _norm_key(s["id"]) or q in _norm_key(s["name"]):
            return s
    return None


def _find_skill_path(sid):
    _ensure_skills_dir()
    target = _slugify(sid)
    direct = os.path.join(SKILLS_DIR, f"{target}.md")
    if os.path.isfile(direct):
        return direct
    for entry in os.listdir(SKILLS_DIR):
        if not entry.lower().endswith(".md"):
            continue
        full = os.path.join(SKILLS_DIR, entry)
        try:
            sk = _parse_skill_file(full, include_content=False)
            if sk["id"] == target:
                return full
        except Exception:
            continue
    return direct


def save_skill(data):
    if not isinstance(data, dict):
        return False, "invalid skill payload"
    name = str(data.get("name") or "").strip()
    content = str(data.get("content") or "").replace("\r\n", "\n").strip()
    if not name:
        return False, "skill name is required"
    if not content:
        return False, "skill content is required"

    sid = _slugify(data.get("id") or name)
    path = _find_skill_path(sid)
    existing = None
    if os.path.isfile(path):
        try:
            existing = _parse_skill_file(path, include_content=True)
        except Exception:
            existing = None

    category = str(data.get("category") or (existing["category"] if existing else "Custom")).strip() or "Custom"
    tagline = str(data.get("tagline") if "tagline" in data else (existing["tagline"] if existing else "")).strip()
    enabled = _parse_bool(data.get("enabled"), default=(existing["enabled"] if existing else True))
    mode = str(data.get("mode") or (existing["mode"] if existing else "auto")).strip().lower()
    if mode not in VALID_MODES:
        mode = "auto"
    builtin = bool(existing["builtin"]) if existing else (sid in BUILTIN_ORDER)

    record = {
        "id": sid,
        "name": name,
        "category": category,
        "tagline": tagline,
        "enabled": enabled,
        "mode": mode,
        "builtin": builtin,
        "content": content,
    }
    try:
        _ensure_skills_dir()
        _atomic_write(path, _serialize_skill(record))
        return True, _parse_skill_file(path, include_content=True)
    except Exception as e:
        return False, str(e)


def toggle_skill(skill_id, enabled=None, mode=None):
    sk = get_skill(skill_id)
    if not sk:
        return False, f"skill '{skill_id}' not found"
    path = _find_skill_path(sk["id"])
    if enabled is not None:
        sk["enabled"] = _parse_bool(enabled, default=sk["enabled"])
    if mode is not None:
        m = str(mode).strip().lower()
        if m not in VALID_MODES:
            return False, f"invalid mode '{mode}' (expected 'auto' or 'always')"
        sk["mode"] = m
    try:
        _atomic_write(path, _serialize_skill(sk))
        return True, _parse_skill_file(path, include_content=True)
    except Exception as e:
        return False, str(e)


def delete_skill(skill_id):
    sk = get_skill(skill_id)
    if not sk:
        return False, f"skill '{skill_id}' not found"
    if sk.get("builtin"):
        return False, f"built-in skill '{sk['name']}' cannot be deleted (disable it instead)"
    path = _find_skill_path(sk["id"])
    try:
        if os.path.isfile(path):
            os.remove(path)
        return True, None
    except Exception as e:
        return False, str(e)


def default_settings():
    return {
        "userName": os.environ.get("USERNAME") or os.environ.get("USER") or "Builder",
        "minimizeToTray": True,
        "autoOpenWindow": True,
        "appPort": int(os.environ.get("ZS_APP_PORT", "17614")),
    }


def load_settings():
    cfg = default_settings()
    if os.path.isfile(SETTINGS_PATH):
        try:
            with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
            if isinstance(saved, dict):
                if isinstance(saved.get("userName"), str) and saved["userName"].strip():
                    cfg["userName"] = saved["userName"].strip()[:40]
                if isinstance(saved.get("minimizeToTray"), bool):
                    cfg["minimizeToTray"] = saved["minimizeToTray"]
                if isinstance(saved.get("autoOpenWindow"), bool):
                    cfg["autoOpenWindow"] = saved["autoOpenWindow"]
                if isinstance(saved.get("appPort"), int) and 1024 <= saved["appPort"] <= 65535:
                    cfg["appPort"] = saved["appPort"]
        except Exception:
            pass
    return cfg


def save_settings(patch):
    cfg = load_settings()
    if isinstance(patch, dict):
        if "userName" in patch and isinstance(patch["userName"], str):
            name = patch["userName"].strip()[:40]
            if name:
                cfg["userName"] = name
        if "minimizeToTray" in patch:
            cfg["minimizeToTray"] = _parse_bool(patch["minimizeToTray"], default=cfg["minimizeToTray"])
        if "autoOpenWindow" in patch:
            cfg["autoOpenWindow"] = _parse_bool(patch["autoOpenWindow"], default=cfg["autoOpenWindow"])
        if "appPort" in patch:
            try:
                p = int(patch["appPort"])
                if 1024 <= p <= 65535:
                    cfg["appPort"] = p
            except Exception:
                pass
    _atomic_write(SETTINGS_PATH, json.dumps(cfg, indent=2) + "\n")
    return cfg

