import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @huggingface/transformers ships ONNX runtime bindings that need to stay
  // outside Webpack's bundling (they pull native .wasm + .node files that
  // Webpack can't trace). Marking it as a server external + a client
  // transpilation-skip lets Next chunk-split it cleanly.
  serverExternalPackages: ["sharp", "@huggingface/transformers", "onnxruntime-node"],
};

export default nextConfig;
