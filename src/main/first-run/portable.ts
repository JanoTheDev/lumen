// The portable exe (electron-builder `portable` target) sets PORTABLE_EXECUTABLE_DIR. In that
// mode Lumen writes no registry entries: no start at login, no updates.
export function isPortable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.PORTABLE_EXECUTABLE_DIR
}
