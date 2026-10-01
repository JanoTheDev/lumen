# SPDX-License-Identifier: GPL-3.0-or-later
"""Lumen Bridge: answers read-only state questions from the Lumen assistant so its Blender
lessons can check each step exactly. Listens on 127.0.0.1:47651 only, needs the token Lumen
writes to %APPDATA%/Lumen/blender-bridge.token, and never runs code it is sent."""

import bpy

from . import server

# Blender 3.6 LTS reads bl_info; 4.2+ reads blender_manifest.toml.
bl_info = {
    "name": "Lumen Bridge",
    "author": "JanoTheDev",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "Runs in the background",
    "description": "Lets the Lumen assistant check lesson steps (read-only, local only)",
    "category": "Interface",
}

TICK = 0.1

_server = None
_ops = server.OperatorLog()


def _window():
    wm = bpy.context.window_manager
    wins = list(wm.windows) if wm else []
    for w in wins:
        if any(a.type == "VIEW_3D" for a in w.screen.areas):
            return w
    return wins[0] if wins else None


def _space(win, area_type):
    if not win:
        return None
    for area in win.screen.areas:
        if area.type == area_type:
            return area.spaces.active
    return None


def _mode(win):
    try:
        with bpy.context.temp_override(window=win):
            return bpy.context.mode
    except Exception:  # noqa: BLE001 - no window yet, or an old Blender
        return getattr(bpy.context, "mode", None)


def _base_color(obj):
    mat = getattr(obj, "active_material", None) if obj else None
    if not mat:
        return None
    if mat.use_nodes and mat.node_tree:
        for node in mat.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED" and "Base Color" in node.inputs:
                return [round(c, 3) for c in node.inputs["Base Color"].default_value]
    return [round(c, 3) for c in mat.diffuse_color]


def _last_op():
    if not _ops.entries:
        return None
    last = _ops.entries[-1]
    return {"idname": last["idname"], "name": last["name"]}


def _state():
    win = _window()
    scene = win.scene if win else bpy.context.scene
    view_layer = win.view_layer if win else bpy.context.view_layer
    obj = view_layer.objects.active if view_layer else None
    mode = _mode(win)
    selected = []
    if view_layer:
        for o in view_layer.objects:
            if o.select_get(view_layer=view_layer):
                selected.append(o.name)
                if len(selected) >= 50:
                    break
    props = _space(win, "PROPERTIES")
    view3d = _space(win, "VIEW_3D")
    face_count = None
    if mode == "EDIT_MESH" and obj and obj.type == "MESH":
        face_count = obj.data.total_face_sel
    return {
        "blender": bpy.app.version_string,
        "bridge": server.VERSION,
        "mode": mode,
        "active_object": obj.name if obj else None,
        "active_object_type": obj.type if obj else None,
        "selected": selected,
        # Blender does not expose the area under the mouse to Python.
        "active_editor_under_mouse": None,
        "workspace": win.workspace.name if win else None,
        "scene_frame": scene.frame_current if scene else None,
        "render_engine": scene.render.engine if scene else None,
        "last_operator": _last_op(),
        "op_seq": _ops.seq,
        "operators": list(_ops.entries),
        "object_count": len(scene.objects) if scene else 0,
        "file_path": bpy.data.filepath,
        "is_dirty": bpy.data.is_dirty,
        "mesh_select_mode": (
            server.select_mode_label(scene.tool_settings.mesh_select_mode) if scene else None
        ),
        "selected_face_count": face_count,
        "properties_context": props.context if props else None,
        "viewport_shading": view3d.shading.type if view3d else None,
        "active_material_base_color": _base_color(obj),
    }


def _object(name):
    obj = bpy.data.objects.get(name)
    if not obj:
        raise ValueError("no such object")
    return {
        "type": obj.type,
        "location": list(obj.location),
        "rotation": list(obj.rotation_euler),
        "scale": list(obj.scale),
        "modifiers": [{"name": m.name, "type": m.type} for m in obj.modifiers],
        "materials": [s.material.name for s in obj.material_slots if s.material],
    }


def _run(req):
    if req["cmd"] == "state":
        return _state()
    return _object(req["name"])


def _poll_operators():
    wm = bpy.context.window_manager
    if not wm:
        return
    _ops.update([(op.as_pointer(), op.bl_idname, op.name) for op in wm.operators])


def _tick():
    if _server is None:
        return None
    try:
        _poll_operators()
    except Exception as e:  # noqa: BLE001 - keep the timer alive
        print("Lumen Bridge: operator poll failed:", e)
    _server.drain(_run)
    return TICK


def register():
    global _server
    srv = server.Server()
    try:
        srv.start()
    except OSError as e:
        print("Lumen Bridge: could not listen on port", server.PORT, "-", e)
        return
    _server = srv
    bpy.app.timers.register(_tick, first_interval=TICK, persistent=True)
    print("Lumen Bridge: listening on", server.HOST, server.PORT)


def unregister():
    global _server
    if bpy.app.timers.is_registered(_tick):
        bpy.app.timers.unregister(_tick)
    if _server:
        _server.stop()
        _server = None
