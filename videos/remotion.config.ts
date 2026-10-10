import { Config } from "@remotion/cli/config"

// Tutorials are screenshots and type. JPEG frames at 95 are indistinguishable
// from PNG once x264 has encoded them, and render several times faster.
Config.setVideoImageFormat("jpeg")
Config.setJpegQuality(95)
Config.setCodec("h264")
Config.setCrf(18)
Config.setPixelFormat("yuv420p")
Config.setConcurrency(4)
