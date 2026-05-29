// Build the correct `input` shape for each KIE.ai model so /api/generate/run
// can stay model-agnostic. Different models use different field names for
// the same concept (resolution vs quality, input_urls vs image_input, etc.).

import { IMAGE_MODELS } from "./models";

export type GenerateCommon = {
  prompt: string;
  aspectRatio: string;
  quality: string;
  inputUrls: string[];
};

export type BuiltJob = {
  kieModelId: string;
  input: Record<string, unknown>;
  useVeoEndpoint: boolean;
};

export function buildKieInput(modelKey: string, common: GenerateCommon): BuiltJob {
  const model = IMAGE_MODELS[modelKey];
  if (!model) throw new Error(`Unknown image model: ${modelKey}`);

  const hasRefs = common.inputUrls.length > 0;
  const useI2I = hasRefs && model.kieModelI2I !== null;
  const kieModelId = useI2I
    ? (model.kieModelI2I as string)
    : (model.kieModelT2I as string);

  const input: Record<string, unknown> = {
    prompt: common.prompt,
  };

  // Aspect ratio
  if (common.aspectRatio) input.aspect_ratio = common.aspectRatio;

  // Quality — translated per model convention
  if (model.qualityParam === "resolution") {
    input.resolution = common.quality;
  } else if (model.qualityParam === "quality") {
    const mapped = model.qualityMap?.[common.quality] ?? common.quality;
    input.quality = mapped;
  }

  // Input reference images — different field names per family
  if (hasRefs) {
    if (modelKey === "nano-banana-pro" || modelKey === "nano-banana") {
      input.image_input = common.inputUrls;
    } else {
      // GPT Image 2 i2i, Wan 2.7 Pro, etc.
      input.input_urls = common.inputUrls;
    }
  }

  // Model-specific extras
  if (modelKey === "nano-banana-pro" || modelKey === "nano-banana") {
    input.output_format = "png";
  }
  if (modelKey === "seedream-4-5") {
    input.nsfw_checker = false;
  }
  if (modelKey === "wan-2-7-image-pro") {
    // Single image per task — keep the registry's "count" semantics
    input.n = 1;
    input.watermark = false;
    input.nsfw_checker = false;
  }

  // GPT Image 2 constraint: 1:1 + 4K is rejected. Downgrade to 2K transparently.
  if (
    (modelKey === "gpt-image-2") &&
    common.aspectRatio === "1:1" &&
    common.quality === "4K"
  ) {
    input.resolution = "2K";
  }
  // GPT Image 2: auto aspect ratio forces 1K
  if (modelKey === "gpt-image-2" && common.aspectRatio === "auto") {
    input.resolution = "1K";
  }

  return {
    kieModelId,
    input,
    useVeoEndpoint: false,
  };
}
