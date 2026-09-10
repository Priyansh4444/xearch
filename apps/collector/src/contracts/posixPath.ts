// POSIX-only deployment (see apps/collector/scripts: macOS/Linux assumptions
// throughout): path math is deterministic. Pin the posix Path implementation
// once so pure layout helpers stay pure — threading a service through value
// constructors would trade call-site clarity for nothing on this platform.
// Effectful code that needs more than path math uses FileSystem/Crypto
// services with layers provided at composition roots (see liveLayers.ts).
import { NodePath } from "@effect/platform-node";
import { Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const context = NodePath.layerPosix.pipe(Layer.build, Effect.scoped, Effect.runSync);

export const posixPath: Path.Path = Context.get(context, Path.Path);
