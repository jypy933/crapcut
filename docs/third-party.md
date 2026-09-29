# Third-party software and models

CrapCut's own code is MIT-licensed. It uses the tools and models below, which
keep their own licences. **None of the tools or models are included in the
installer**: they are downloaded on first run from the official source listed,
pinned to the exact version, and checked against the SHA-256 in
[`src/main/tools/manifest.ts`](../src/main/tools/manifest.ts).

## Downloaded on first run

| Component | Version | Licence | Source |
| --- | --- | --- | --- |
| FFmpeg (Windows build by gyan.dev, "essentials") | 8.1.1 | GPL-3.0 | https://github.com/GyanD/codexffmpeg/releases/tag/8.1.1 |
| yt-dlp | 2026.08.19 | Unlicense | https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19 |
| TwitchDownloaderCLI | 1.56.5 | MIT | https://github.com/lay295/TwitchDownloader/releases/tag/1.56.5 |
| whisper.cpp (CPU build) | 1.9.4 (b5130) | MIT | https://github.com/ggml-org/whisper.cpp/releases/tag/b5130 |
| whisper.cpp (CUDA 11.8 build, NVIDIA only; includes NVIDIA CUDA runtime under the NVIDIA CUDA EULA) | 1.9.4 (b5130) | MIT | https://github.com/ggml-org/whisper.cpp/releases/tag/b5130 |
| llama.cpp (Vulkan build) | b11236 | MIT | https://github.com/ggml-org/llama.cpp/releases/tag/b11236 |
| Whisper large-v3-turbo and small (both q8_0; large transcribes the whole VOD on NVIDIA, small transcribes it on the CPU with large re-run on the kept clips only) | ggml | MIT (OpenAI Whisper) | https://huggingface.co/ggerganov/whisper.cpp |
| Silero VAD | 6.2.0 | MIT | https://huggingface.co/ggml-org/whisper-vad |
| Qwen3.5 9B (Q4_K_M, unsloth GGUF build; no official GGUF from the Qwen org yet), or Ministral 3 3B Instruct 2512 (Q4_K_M) on smaller GPUs | Q4_K_M | Apache-2.0 | https://huggingface.co/Qwen/Qwen3.5-9B (weights), https://huggingface.co/unsloth/Qwen3.5-9B-GGUF (quantization); https://huggingface.co/mistralai (3B) |
| Voice separator: CrapCut's driver on demucs.cpp (includes Eigen, MPL-2.0, and libnyquist, BSD-2-Clause), built by this repo's CI ([separator.yml](../.github/workflows/separator.yml)) | tools-separator-1 | MIT | https://github.com/jypy933/crapcut/releases/tag/tools-separator-1 |
| Demucs htdemucs weights (Meta), converted to ggml by the same CI job | htdemucs-4s-f16 | MIT | https://github.com/facebookresearch/demucs |

## Inside the app

| Component | Licence |
| --- | --- |
| Electron (includes Chromium and Node.js) | MIT (Chromium notices in `LICENSES.chromium.html` next to the app) |
| React, React DOM | MIT |
| Lucide icons | ISC |
| Zod | MIT |
| electron-updater | MIT |
| yauzl | MIT |
| Montserrat font (caption font) | SIL Open Font License 1.1, see `resources/fonts/OFL.txt` |

The About screen in the app lists the same information with links.

## Updating a pinned tool

1. Pick the new official release.
2. Update `url`, `version`, `size` and `sha256` in `src/main/tools/manifest.ts`
   (GitHub shows the SHA-256 of release assets; for Hugging Face use the file's
   LFS SHA-256).
3. Run `npm run e2e` with a short VOD, then release a new app version. Old
   versions are removed automatically after the new one installs.
