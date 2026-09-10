// Live Node layers for the collector's Effect services (FileSystem, Crypto).
// Provided once at composition roots (CLI mains) and inside the
// promise/async bridges in pilot/layout.ts so promise-first callers and
// tests keep working without layer boilerplate. Pure path math intentionally
// lives in posixPath.ts instead of the Path service.
import * as Layer from "effect/Layer";
import { NodeCrypto, NodeFileSystem } from "@effect/platform-node";

export const CollectorLive = Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer);
