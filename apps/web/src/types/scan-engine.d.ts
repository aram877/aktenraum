// Type shim for the untyped jscanify client subpath. The package ships
// no .d.ts files for its `/client` subpath. We shim the client subpath as
// a constructor returning an opaque facade; the engine wrapper in
// lib/scan-engine.ts is the only consumer and treats the facade as
// `unknown` everywhere off the boundary.
//
// @techstark/opencv-js ships its own ambient `declare var cv` globally,
// so we do NOT redeclare it here — that would conflict.

declare module "jscanify/client" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Jscanify: new () => any;
  export default Jscanify;
}
