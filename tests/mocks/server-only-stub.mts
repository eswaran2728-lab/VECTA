// Stub for the "server-only" import-guard package, which isn't
// installed as a direct dependency in this repo (Next.js normally
// supplies it). It has no exports; importing it is a pure side effect
// in real code (it throws if ever bundled into client code). This
// stub is a no-op so Phase 8 server-action files can be loaded directly
// under plain `node --test` for application-level testing.
export {};
