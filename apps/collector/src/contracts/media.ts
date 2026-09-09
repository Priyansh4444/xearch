import { Option } from "effect";
import * as Schema from "effect/Schema";

export const ProviderMediaType = {
  Photo: "photo",
  MosaicPhoto: "mosaic_photo",
  Video: "video",
  Gif: "gif",
} as const;
export type ProviderMediaType = (typeof ProviderMediaType)[keyof typeof ProviderMediaType];
export const ProviderMediaTypeSchema = Schema.Literals([
  ProviderMediaType.Photo,
  ProviderMediaType.MosaicPhoto,
  ProviderMediaType.Video,
  ProviderMediaType.Gif,
]);

export const IngressMediaType = {
  Image: "image",
  Video: "video",
  Gif: "gif",
} as const;
export type IngressMediaType = (typeof IngressMediaType)[keyof typeof IngressMediaType];
export const IngressMediaTypeSchema = Schema.Literals([
  IngressMediaType.Image,
  IngressMediaType.Video,
  IngressMediaType.Gif,
]);

export function parseProviderMediaType(value: unknown): ProviderMediaType | null {
  const parsed = Schema.decodeUnknownOption(ProviderMediaTypeSchema)(value);
  return Option.isSome(parsed) ? parsed.value : null;
}

export function toIngressMediaType(type: ProviderMediaType): IngressMediaType {
  switch (type) {
    case ProviderMediaType.Photo:
    case ProviderMediaType.MosaicPhoto:
      return IngressMediaType.Image;
    case ProviderMediaType.Video:
      return IngressMediaType.Video;
    case ProviderMediaType.Gif:
      return IngressMediaType.Gif;
  }
}

export function isImageProviderMedia(type: ProviderMediaType): boolean {
  return type === ProviderMediaType.Photo || type === ProviderMediaType.MosaicPhoto;
}
