// Registry of KIE.ai models exposed by PixelForge.
//
// IDs validated against KIE.ai docs and live API. Prices flagged with
// `pricingNote: "Estimated"` are educated guesses until confirmed on
// https://kie.ai/pricing.

export type ImageModel = {
  label: string;
  vendor: string;
  kieModelT2I: string | null;
  kieModelI2I: string | null;
  supports: Array<"t2i" | "i2i" | "edit">;
  aspectRatios: string[];
  qualities: string[]; // UI labels for the quality selector
  qualityParam: "resolution" | "quality" | "none"; // KIE input field name
  // Optional remap from UI label -> KIE value (e.g. Seedream: 2K -> basic)
  qualityMap?: Record<string, string>;
  pricing: Record<string, number>;
  defaultPricePerImage: number;
  pricingNote?: string;
  maxInputImages: number;
  notes: string;
  badge?: "TOP" | "NEW" | "SOON";
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

export type LipsyncQuality = {
  label: string;          // "Pro" / "Standard"
  resolution: string;     // "1080P" / "720P"
  fps: number;            // 48 / 24
  kieModel: string;       // KIE model id for this quality
  pricePerSecond: number; // USD per second of audio
};

export type LipsyncModel = {
  label: string;
  vendor: string;
  maxAudioSeconds: number;
  qualities: LipsyncQuality[]; // first entry = default
  badge?: "TOP" | "NEW" | "SOON" | "PREMIUM";
  notes: string;
};

export type UpscaleModel = {
  label: string;
  vendor: string;
  kieModel: string;
  factors: number[];
  pricePerImage?: number;
  pricePerSecond?: number;
};

export function priceForQuality(model: ImageModel, quality: string): number {
  return model.pricing[quality] ?? model.defaultPricePerImage;
}

export const IMAGE_MODELS: Record<string, ImageModel> = {
  "nano-banana-pro": {
    label: "Nano Banana Pro",
    vendor: "Google (Gemini 3 Pro Image)",
    kieModelT2I: "nano-banana-pro",
    kieModelI2I: "nano-banana-pro",
    supports: ["t2i", "i2i"],
    aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "auto"],
    qualities: ["1K", "2K", "4K"],
    qualityParam: "resolution",
    // Confirmed on KIE Tarification (May 2026)
    pricing: { "1K": 0.09, "2K": 0.09, "4K": 0.12 },
    defaultPricePerImage: 0.09,
    maxInputImages: 8,
    notes: "Best 4K image model. Strong in-image text rendering & brand fidelity.",
    badge: "TOP",
  },
  "nano-banana": {
    label: "Nano Banana",
    vendor: "Google (Gemini 2.x Image)",
    kieModelT2I: "google/nano-banana",
    kieModelI2I: "google/nano-banana",
    supports: ["t2i", "i2i"],
    aspectRatios: ["1:1", "9:16", "16:9", "4:3", "3:4"],
    qualities: ["1K", "2K"],
    qualityParam: "resolution",
    pricing: { "1K": 0.02, "2K": 0.039 },
    defaultPricePerImage: 0.039,
    pricingNote: "Estimated",
    maxInputImages: 3,
    notes: "Fast & cheap variant of Nano Banana Pro.",
  },
  "gpt-image-2": {
    label: "GPT Image 2",
    vendor: "OpenAI",
    kieModelT2I: "gpt-image-2-text-to-image",
    kieModelI2I: "gpt-image-2-image-to-image",
    supports: ["t2i", "i2i"],
    aspectRatios: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9", "9:21"],
    qualities: ["1K", "2K", "4K"],
    qualityParam: "resolution",
    pricing: { "1K": 0.04, "2K": 0.07, "4K": 0.16 },
    defaultPricePerImage: 0.07,
    pricingNote: "Estimated",
    maxInputImages: 16,
    notes: "4K with near-perfect text rendering. Note: 1:1 cannot reach 4K; aspect=auto forces 1K.",
    badge: "NEW",
  },
  "seedream-4-5": {
    label: "Seedream 4.5",
    vendor: "ByteDance",
    kieModelT2I: "seedream/4.5-text-to-image",
    kieModelI2I: null,
    supports: ["t2i"],
    aspectRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "2:3", "3:2", "21:9"],
    qualities: ["2K", "4K"], // UI labels — sent as basic/high
    qualityParam: "quality",
    qualityMap: { "2K": "basic", "4K": "high" },
    pricing: { "2K": 0.05, "4K": 0.10 },
    defaultPricePerImage: 0.05,
    pricingNote: "Estimated",
    maxInputImages: 0,
    notes: "Photorealistic with intelligent visual reasoning.",
  },
  "wan-2-7-image-pro": {
    label: "Wan 2.7 Pro",
    vendor: "Alibaba",
    kieModelT2I: "wan/2-7-image-pro",
    kieModelI2I: "wan/2-7-image-pro",
    supports: ["t2i", "i2i", "edit"],
    aspectRatios: ["1:1", "16:9", "4:3", "21:9", "3:4", "9:16", "8:1", "1:8"],
    qualities: ["1K", "2K", "4K"],
    qualityParam: "resolution",
    pricing: { "1K": 0.04, "2K": 0.06, "4K": 0.10 },
    defaultPricePerImage: 0.06,
    pricingNote: "Estimated",
    maxInputImages: 9,
    notes: "Strong editing capabilities, supports panoramic 8:1 / 1:8.",
    badge: "NEW",
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
};

export const AVATAR_MODELS: Record<string, AvatarModel> = {};
export const UPSCALE_MODELS: Record<string, UpscaleModel> = {};

// ---------------------------------------------------------------------------
// Video creation (text+image -> video)
// ---------------------------------------------------------------------------

export type VideoCreateQuality = {
  label: string;          // "Std" / "Pro" / "4K"
  displayLabel: string;   // "720p" / "1080p" / "4K"
  resolution: string;     // e.g. "1920×1080"
  kieMode: string;        // value passed to KIE: "std" | "pro" | "4K"
  // KIE bills more when sound is enabled (+50% on Std/Pro, no premium on 4K).
  pricePerSecondNoAudio: number;
  pricePerSecondWithAudio: number;
};

export type VideoCreateModel = {
  label: string;
  vendor: string;
  kieModel: string;
  aspectRatios: string[];
  durations: number[];
  qualities: VideoCreateQuality[];
  supportsEndFrame: boolean;
  supportsSound: boolean;
  pricingNote?: string;
  badge?: "TOP" | "NEW" | "SOON" | "PREMIUM";
  notes: string;
};

export const VIDEO_CREATE_MODELS: Record<string, VideoCreateModel> = {
  "kling-3-0-video": {
    label: "Kling 3.0",
    vendor: "Kling",
    kieModel: "kling-3.0/video",
    aspectRatios: ["16:9", "9:16", "1:1"],
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    qualities: [
      // KIE official: credits/s @ $0.005/credit (1000 credits = $5).
      // Std:  14 cr / 20 cr — 720p
      // Pro:  18 cr / 27 cr — 1080p
      // 4K:   67 cr (same with/without audio) — 4K
      { label: "Std", displayLabel: "720p",  resolution: "1280×720",  kieMode: "std", pricePerSecondNoAudio: 0.07,  pricePerSecondWithAudio: 0.10  },
      { label: "Pro", displayLabel: "1080p", resolution: "1920×1080", kieMode: "pro", pricePerSecondNoAudio: 0.09,  pricePerSecondWithAudio: 0.135 },
      { label: "4K",  displayLabel: "4K",    resolution: "3840×2160", kieMode: "4K",  pricePerSecondNoAudio: 0.335, pricePerSecondWithAudio: 0.335 },
    ],
    supportsEndFrame: true,
    supportsSound: true,
    badge: "TOP",
    notes: "Image-to-video with start frame + optional end frame. Single shot, 3-15s.",
  },
};

export const LIPSYNC_MODELS: Record<string, LipsyncModel> = {
  "kling-avatars-2": {
    label: "Kling Avatars 2.0",
    vendor: "Kling",
    maxAudioSeconds: 300,
    qualities: [
      // Pro is the default — higher resolution, double the price.
      { label: "Pro",      resolution: "1080P", fps: 48, kieModel: "kling/ai-avatar-pro",      pricePerSecond: 0.08 },
      { label: "Standard", resolution: "720P",  fps: 24, kieModel: "kling/ai-avatar-standard", pricePerSecond: 0.04 },
    ],
    badge: "TOP",
    notes: "Talking-head avatar. Choose between 1080P (Pro) and 720P (Standard).",
  },
};

export function getAllModels() {
  return {
    image: IMAGE_MODELS,
    video: VIDEO_MODELS,
    avatar: AVATAR_MODELS,
    upscale: UPSCALE_MODELS,
    lipsync: LIPSYNC_MODELS,
  };
}
