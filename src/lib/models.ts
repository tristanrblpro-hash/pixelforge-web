// Registry of KIE.ai models exposed by PixelForge.
//
// The `kieModel*` IDs below align with KIE.ai's public catalog as of 2026-05.
// If a submission fails with "model not found", verify the exact string at
// https://kie.ai/models and edit here. Pricing is indicative — KIE's billing
// dashboard is authoritative.

export type ImageModel = {
  label: string;
  vendor: string;
  kieModelT2I: string;
  kieModelI2I: string | null;
  supports: Array<"t2i" | "i2i" | "edit">;
  aspectRatios: string[];
  resolutions: string[];
  pricePerImage: number;
  maxInputImages: number;
  notes: string;
};

export type VideoModel = {
  label: string;
  vendor: string;
  kieModelT2V: string;
  kieModelI2V: string | null;
  supports: Array<"t2v" | "i2v" | "audio">;
  aspectRatios: string[];
  resolutions: string[];
  durations: number[];
  pricePerSecond: Record<string, number>;
  usesVeoEndpoint: boolean;
};

export type AvatarModel = {
  label: string;
  vendor: string;
  kieModel: string;
  pricePerSecond: number;
  maxAudioSeconds: number;
};

export type UpscaleModel = {
  label: string;
  vendor: string;
  kieModel: string;
  factors: number[];
  pricePerImage?: number;
  pricePerSecond?: number;
};

export const IMAGE_MODELS: Record<string, ImageModel> = {
  "nano-banana-pro": {
    label: "Nano Banana Pro",
    vendor: "Google (Gemini 3 Pro Image)",
    kieModelT2I: "google/nano-banana-pro",
    kieModelI2I: "google/nano-banana-pro",
    supports: ["t2i", "i2i"],
    aspectRatios: ["1:1", "9:16", "16:9", "4:3", "3:4", "3:2", "2:3"],
    resolutions: ["1024x1024", "1024x1792", "1792x1024"],
    pricePerImage: 0.24,
    maxInputImages: 3,
    notes: "In-image text rendering, product fidelity, editorial style.",
  },
  "gpt-image-2": {
    label: "GPT Image 2",
    vendor: "OpenAI",
    kieModelT2I: "openai/gpt-image-2-text-to-image",
    kieModelI2I: "openai/gpt-image-2-image-to-image",
    supports: ["t2i", "i2i", "edit"],
    aspectRatios: ["1:1", "9:16", "16:9"],
    resolutions: ["1024x1024", "1024x1792", "1792x1024"],
    pricePerImage: 0.19,
    maxInputImages: 4,
    notes: "Best for fine-grained edits and batch-edit pipelines.",
  },
  "flux-pro-1-1": {
    label: "Flux Pro 1.1",
    vendor: "Black Forest Labs",
    kieModelT2I: "bfl/flux-pro-1-1",
    kieModelI2I: null,
    supports: ["t2i"],
    aspectRatios: ["1:1", "9:16", "16:9", "4:3", "3:4"],
    resolutions: ["1024x1024", "1024x1792", "1792x1024"],
    pricePerImage: 0.04,
    maxInputImages: 0,
    notes: "Fast, cheap, photorealistic.",
  },
  "ideogram-v3": {
    label: "Ideogram v3",
    vendor: "Ideogram",
    kieModelT2I: "ideogram/v3",
    kieModelI2I: null,
    supports: ["t2i"],
    aspectRatios: ["1:1", "9:16", "16:9", "4:3", "3:4"],
    resolutions: ["1024x1024", "1024x1792", "1792x1024"],
    pricePerImage: 0.06,
    maxInputImages: 0,
    notes: "Strong typography & poster layouts.",
  },
};

export const VIDEO_MODELS: Record<string, VideoModel> = {
  "kling-v2-1-master": {
    label: "Kling 2.1 Master",
    vendor: "Kling",
    kieModelT2V: "kling/kling-v2-1-master",
    kieModelI2V: "kling/kling-v2-1-master",
    supports: ["t2v", "i2v"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    resolutions: ["std", "pro"],
    durations: [5, 10],
    pricePerSecond: { std: 0.18, pro: 0.28 },
    usesVeoEndpoint: false,
  },
  "kling-v2-5-turbo-pro": {
    label: "Kling 2.5 Turbo Pro",
    vendor: "Kling",
    kieModelT2V: "kling/kling-v2-5-turbo-pro",
    kieModelI2V: "kling/kling-v2-5-turbo-pro",
    supports: ["t2v", "i2v"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    resolutions: ["std", "pro"],
    durations: [5, 10],
    pricePerSecond: { std: 0.14, pro: 0.22 },
    usesVeoEndpoint: false,
  },
  "sora-2": {
    label: "Sora 2",
    vendor: "OpenAI",
    kieModelT2V: "openai/sora-2",
    kieModelI2V: null,
    supports: ["t2v"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    resolutions: ["720p", "1080p"],
    durations: [4, 8, 12],
    pricePerSecond: { "720p": 0.12, "1080p": 0.22 },
    usesVeoEndpoint: false,
  },
  "veo-3": {
    label: "Veo 3",
    vendor: "Google",
    kieModelT2V: "google/veo-3",
    kieModelI2V: "google/veo-3",
    supports: ["t2v", "i2v", "audio"],
    aspectRatios: ["16:9", "9:16"],
    resolutions: ["720p", "1080p"],
    durations: [5, 8],
    pricePerSecond: { "720p": 0.3, "1080p": 0.5 },
    usesVeoEndpoint: true,
  },
  "seedance-v1-pro": {
    label: "Seedance V1 Pro",
    vendor: "ByteDance",
    kieModelT2V: "bytedance/seedance-v1-pro",
    kieModelI2V: "bytedance/seedance-v1-pro",
    supports: ["t2v", "i2v"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    resolutions: ["480p", "720p", "1080p"],
    durations: [5, 10],
    pricePerSecond: { "480p": 0.06, "720p": 0.1, "1080p": 0.18 },
    usesVeoEndpoint: false,
  },
};

export const AVATAR_MODELS: Record<string, AvatarModel> = {
  "kling-avatar-2-std": {
    label: "Kling Avatar 2.0 Std",
    vendor: "Kling",
    kieModel: "kling/kling-avatar-2-std",
    pricePerSecond: 0.3,
    maxAudioSeconds: 300,
  },
  "kling-avatar-2-pro": {
    label: "Kling Avatar 2.0 Pro",
    vendor: "Kling",
    kieModel: "kling/kling-avatar-2-pro",
    pricePerSecond: 0.5,
    maxAudioSeconds: 300,
  },
};

export const UPSCALE_MODELS: Record<string, UpscaleModel> = {
  "topaz-image": {
    label: "Topaz Image Upscale",
    vendor: "Topaz Labs",
    kieModel: "topaz/image-upscale",
    factors: [2, 4, 8],
    pricePerImage: 0.05,
  },
  "topaz-video": {
    label: "Topaz Video Upscale",
    vendor: "Topaz Labs",
    kieModel: "topaz/video-upscale",
    factors: [2, 4],
    pricePerSecond: 0.4,
  },
};

export function getAllModels() {
  return {
    image: IMAGE_MODELS,
    video: VIDEO_MODELS,
    avatar: AVATAR_MODELS,
    upscale: UPSCALE_MODELS,
  };
}
