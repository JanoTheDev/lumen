// The old window set (HUD, status bubble, answer card, highlight and dwell ring windows) is
// gone: the assistant bar, screen layer and panel window always run. Kept for callers that
// still branch on it; config ui.v2 is ignored.
export function uiV2(): boolean {
  return true
}
