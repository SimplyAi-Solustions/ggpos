import { Config } from "@remotion/cli/config"

// Tutorials are screenshots and type: crisp stills matter more than speed.
Config.setVideoImageFormat("png")
Config.setCodec("h264")
Config.setCrf(18)
Config.setPixelFormat("yuv420p")
Config.setConcurrency(4)
