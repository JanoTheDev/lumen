# Sources and version notes

Checked on 2026-10-01 against the Blender 5.2 LTS manual (the "latest" manual at that date). All lesson text is written from scratch.

## Version assumptions

- Current LTS lines: 5.2 LTS (5.2.2) and 4.5 LTS (4.5.14), per https://www.blender.org/download/lts/
- Lessons target `>=4.2`. Every shortcut used in the lessons is unchanged from 4.2 through 5.2 in the default keymap.
- Blender 5.0 moved the number-row collection toggles from the 3D Viewport to the Outliner and renamed "Full Screen Area" to "Focus Mode". Neither affects these lessons.

## Official pages consulted

- Navigation (orbit, pan, zoom, Frame All, Frame Selected): https://docs.blender.org/manual/en/latest/editors/3dview/navigate/navigation.html
- Viewpoint numpad keys: https://docs.blender.org/manual/en/latest/editors/3dview/navigate/viewpoint.html
- Perspective/Orthographic (Numpad 5): https://docs.blender.org/manual/en/latest/editors/3dview/navigate/projections.html
- Camera view (Numpad 0, Ctrl Numpad 0): https://docs.blender.org/manual/en/latest/editors/3dview/navigate/camera_view.html
- Viewport shading and the Z pie: https://docs.blender.org/manual/en/latest/editors/3dview/display/shading.html
- Selecting (A, Alt A, B, C): https://docs.blender.org/manual/en/latest/scene_layout/object/selecting.html
- Move and transform: https://docs.blender.org/manual/en/latest/scene_layout/object/editing/transform/move.html
- Delete: https://docs.blender.org/manual/en/latest/scene_layout/object/editing/delete.html
- Extrude Faces: https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/extrude_faces.html
- Material slots: https://docs.blender.org/manual/en/latest/render/materials/assignment.html
- Image Save / Save As (Alt S, Shift Alt S): https://docs.blender.org/manual/en/latest/editors/image/editing.html
- Maximize Area (Ctrl Space): https://docs.blender.org/manual/en/latest/interface/window_system/areas.html
- 5.0 UI and keymap changes: https://developer.blender.org/docs/release_notes/5.0/user_interface/

## Unverified, check on a real install

- `regions.json` fractions are estimates of the default Layout workspace at 1920x1080, not measurements.
- UIA quality "none" is based on Blender drawing its own UI; not yet confirmed with Accessibility Insights.
- The render window title "Blender Render" (used by a window-title check in lesson 05).
- The label of the confirm button in the image Save As file browser ("Save As Image").
- Bridge `expect` keys are provisional until the add-on (T23) exists. Keys beyond the planned `state` API: `active_object_type`, `mesh_select_mode`, `selected_face_count`, `properties_context`, `active_material_base_color_changed`, `viewport_shading`.
- The operator id recorded for E in face mode (`VIEW3D_OT_edit_mesh_extrude_move_normal`); the history may report the inner `MESH_OT_extrude_region` instead.
- Viewport-only steps (orbit, pan, zoom) have no bridge check, since the planned bridge does not expose the view matrix; they use vision and keypress.
