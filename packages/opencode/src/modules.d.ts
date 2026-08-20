// The dispatch-tui typecheck program pulls in ../tui sources, but ambient
// declarations from packages/tui (modules.d.ts) are not part of this program.
// sherpa-onnx-node ships no types, so redeclare the shorthand module here.
declare module "sherpa-onnx-node"
