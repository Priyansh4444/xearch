import { v } from "convex/values";

export const MEDIA_TYPES = ["none", "image", "video", "gif"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];
export const VISUAL_MEDIA_TYPES = ["image", "video", "gif"] as const;
export type VisualMediaType = (typeof VISUAL_MEDIA_TYPES)[number];

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
