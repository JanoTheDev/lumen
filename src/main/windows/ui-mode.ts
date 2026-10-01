// Deprecated shim: the assistant bar and screen layer are the only UI. Remove once
// a11y/install-switch.ts and ipc/query.ts drop their uiV2() branches.
export const uiV2 = (): true => true
