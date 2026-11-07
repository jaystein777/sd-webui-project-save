"""Project Save: saves and restores the state of the txt2img and img2img tabs.

Each save is a new version folder, <folder>/<project>/<timestamp>/, holding project.json and the images in use.
<folder> defaults to outputs/projects; folders used are remembered in outputs/projects/_folders.json so Load
can list them, and Load reads only from those. Nothing is ever overwritten. The page side is in javascript/project_save.js.
"""
import base64
import json
import re
import time
from pathlib import Path

from fastapi import Body, HTTPException

from modules import paths, script_callbacks

ROOT = Path(paths.data_path) / "outputs" / "projects"
DATA_URL = re.compile(r"^data:image/(png|jpeg|webp);base64,(.+)$", re.S)


def _clean(name: str) -> str:
    """A safe single folder name, or an error."""
    name = re.sub(r"[^\w\- .]", "_", str(name or "")).strip(" .")
    if not name:
        raise HTTPException(400, "A project needs a name.")
    return name[:100]


def _known_folders() -> list:
    try:
        saved = json.loads((ROOT / "_folders.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = []
    return [str(ROOT)] + [f for f in saved if f != str(ROOT)]


def _save_folder(folder: str) -> Path:
    """The folder to save in, remembered for Load. Blank means the default."""
    folder = str(folder or "").strip().strip('"')
    if not folder:
        return ROOT
    path = Path(folder)
    if not path.is_absolute():
        raise HTTPException(400, f"Save to needs a full path, like Z:/Projects. Got: {folder}")
    known = _known_folders()
    if str(path) not in known:
        ROOT.mkdir(parents=True, exist_ok=True)
        (ROOT / "_folders.json").write_text(json.dumps(known[1:] + [str(path)], indent=1), encoding="utf-8")
    return path


def _version_dir(project: str, version: str, base: str = "") -> Path:
    base = base or str(ROOT)
    if base not in _known_folders():
        raise HTTPException(403, f"Not a Project Save folder: {base}")
    folder = Path(base) / _clean(project) / _clean(version)
    if not (folder / "project.json").is_file():
        raise HTTPException(404, f"No saved version {project} / {version}.")
    return folder


def _save(body: dict):
    project = _clean(body.get("project"))
    base = _save_folder(body.get("folder"))
    stamp = time.strftime("%Y%m%d-%H%M%S")
    folder, n = base / project / stamp, 2
    while folder.exists():
        folder, n = base / project / f"{stamp}_{n}", n + 1
    try:
        folder.mkdir(parents=True)
    except OSError as e:
        raise HTTPException(400, f"Can't save to {base}: {e}")

    saved = {}
    for key, url in (body.get("images") or {}).items():
        match = DATA_URL.match(url or "")
        if not match:
            continue
        file = f"{_clean(key)}.{'jpg' if match[1] == 'jpeg' else match[1]}"
        (folder / file).write_bytes(base64.b64decode(match[2]))
        saved[key] = file

    state = {k: body.get(k) for k in ("tab", "subtab", "quick", "fields", "note")}
    state.update(project=project, version=folder.name, images=saved)
    (folder / "project.json").write_text(json.dumps(state, indent=1), encoding="utf-8")
    return {"project": project, "version": folder.name, "folder": str(folder), "images": len(saved)}


def _list():
    out = []
    for base in _known_folders():
        if not Path(base).is_dir():
            continue
        for project in sorted(p for p in Path(base).iterdir() if p.is_dir()):
            versions = sorted((v.name for v in project.iterdir() if (v / "project.json").is_file()), reverse=True)
            if versions:
                out.append({"project": project.name, "versions": versions, "folder": base})
    return out


def _load(project: str, version: str, folder: str = ""):
    folder = _version_dir(project, version, folder)
    state = json.loads((folder / "project.json").read_text(encoding="utf-8"))
    images = {}
    for key, file in (state.get("images") or {}).items():
        kind = {"jpg": "jpeg"}.get(Path(file).suffix[1:], Path(file).suffix[1:])
        images[key] = f"data:image/{kind};base64," + base64.b64encode((folder / file).read_bytes()).decode()
    state["images"] = images
    return state


def on_app_started(_demo, app):
    app.add_api_route("/project_save/save", lambda body=Body(...): _save(body), methods=["POST"])
    app.add_api_route("/project_save/list", _list, methods=["GET"])
    app.add_api_route("/project_save/load", _load, methods=["GET"])


script_callbacks.on_app_started(on_app_started)
