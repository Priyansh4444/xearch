import { Option } from "effect";
import * as Schema from "effect/Schema";

export const ProviderMediaTypeSchema = Schema.Literals([
  "photo",
  "mosaic_photo",
  "video",
  "gif",
]);
export type ProviderMediaType = Schema.Schema.Type<typeof ProviderMediaTypeSchema>;

export const IngressMediaTypeSchema = Schema.Literals(["image", "video", "gif"]);
export type IngressMediaType = Schema.Schema.Type<typeof IngressMediaTypeSchema>;

export function parseProviderMediaType(value: unknown): ProviderMediaType | null {
  const parsed = Schema.decodeUnknownOption(ProviderMediaTypeSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

export function toIngressMediaType(type: ProviderMediaType): IngressMediaType {
  switch (type) {
    case "photo":
    case "mosaic_photo":
      return "image";
    case "video":
      return "video";
    case "gif":
      return "gif";
  }
}
