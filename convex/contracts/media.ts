import { v } from "convex/values";

export const MediaType = {
  None: "none",
  Image: "image",
  Video: "video",
  Gif: "gif",
} as const;
export type MediaType = (typeof MediaType)[keyof typeof MediaType];
export const MEDIA_TYPES = [
  MediaType.None,
  MediaType.Image,
  MediaType.Video,
  MediaType.Gif,
] as const;

export const VisualMediaType = {
  Image: MediaType.Image,
  Video: MediaType.Video,
  Gif: MediaType.Gif,
} as const;
export type VisualMediaType = (typeof VisualMediaType)[keyof typeof VisualMediaType];
export const VISUAL_MEDIA_TYPES = [
  VisualMediaType.Image,
  VisualMediaType.Video,
  VisualMediaType.Gif,
] as const;

export const mediaTypeValidator = v.union(
  v.literal("none"),
  v.literal("image"),
  v.literal("video"),
  v.literal("gif"),
);

export const visualMediaTypeValidator = v.union(
  v.literal("image"),
  v.literal("video"),
  v.literal("gif"),
);
