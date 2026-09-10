// One ManagedRuntime per process for the collector's Node layers.
//
// The promise-returning bridges in pilot/, config/, normalization/ and probe/
// are the composition roots for promise callers (CLI mains, the export script
// and tests), so the layers are built exactly once here instead of on every
// bridge call. Effect-native callers keep composing effects and provide their
// own layers at their entry point.
import * as ManagedRuntime from "effect/ManagedRuntime";
import { CollectorLive } from "./liveLayers.ts";

export const CollectorRuntime = ManagedRuntime.make(CollectorLive);
