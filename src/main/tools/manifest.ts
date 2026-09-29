// Every external tool and model CrapCut downloads, pinned to an exact version
// and SHA-256. Nothing here is bundled in the installer. To update a tool,
// change its entry (url, sha256, size) and ship a new app release.

import { canRunBigLlm, LLM_BIG_MIN_VRAM_MB } from '@shared/hardware'
import type { HardwareProfile } from '@shared/types'

export type ToolId =
  | 'ffmpeg'
  | 'yt-dlp'
  | 'chat-downloader'
  | 'whisper-cpu'
  | 'whisper-cuda'
  | 'llama'
  | 'model-whisper-large'
  | 'model-whisper-small'
  | 'model-vad'
  | 'model-llm-9b'
  | 'model-llm-8b'
  | 'model-llm-3b'
  | 'separator'
  | 'model-demucs'

export interface Licence {
  name: string
  url: string
  note?: string
}

export interface Artifact {
  id: ToolId
  label: string
  version: string
  url: string
  sha256: string
  /** Download size in bytes. */
  size: number
  kind: 'zip' | 'file'
  /** For zips: only extract entries matching this (keeps installs small). */
  include?: RegExp
  /** Path of the main file inside the install folder. */
  entry: string
  licence: Licence
  /** The app works without it (e.g. the LLM only improves results). */
  optional: boolean
  /** Whether this machine needs it. */
  needed: (hw: HardwareProfile) => boolean
  /**
   * Retired by a newer pinned artifact for the same role (e.g. the Ministral
   * 8B language model, replaced by Qwen3.5 9B). Kept in this list only so an
   * existing install can still be found, used as a fallback and cleanly
   * swapped out (see `tools/llmMigration.ts`); never downloaded fresh and
   * left out of the About screen's licence list.
   */
  deprecated?: boolean
}

const GH = 'https://github.com'
const HF = 'https://huggingface.co'

export { LLM_BIG_MIN_VRAM_MB }

export const ARTIFACTS: readonly Artifact[] = [
  {
    id: 'ffmpeg',
    label: 'FFmpeg',
    version: '8.1.1',
    url: `${GH}/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-essentials_build.zip`,
    sha256: '6f58ce889f59c311410f7d2b18895b33c03456463486f3b1ebc93d97a0f54541',
    size: 109282242,
    kind: 'zip',
    include: /\/bin\/(ffmpeg|ffprobe)\.exe$|\/LICENSE$/,
    entry: 'ffmpeg-8.1.1-essentials_build/bin/ffmpeg.exe',
    licence: { name: 'GPL-3.0', url: 'https://ffmpeg.org/legal.html', note: 'Windows build by gyan.dev' },
    optional: false,
    needed: () => true
  },
  {
    id: 'yt-dlp',
    label: 'yt-dlp',
    version: '2026.08.19',
    url: `${GH}/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe`,
    sha256: '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
    size: 17840399,
    kind: 'file',
    entry: 'yt-dlp.exe',
    licence: { name: 'Unlicense', url: 'https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE' },
    optional: false,
    needed: () => true
  },
  {
    id: 'chat-downloader',
    label: 'TwitchDownloaderCLI',
    version: '1.56.5',
    url: `${GH}/lay295/TwitchDownloader/releases/download/1.56.5/TwitchDownloaderCLI-1.56.5-Windows-x64.zip`,
    sha256: '8b1b0695f2b1b6bf0d2535fab4b84032951cded8cf4078dfdf4d58e391c813a0',
    size: 52226305,
    kind: 'zip',
    include: /^(TwitchDownloaderCLI\.exe|COPYRIGHT\.txt|THIRD-PARTY-LICENSES\.txt)$/,
    entry: 'TwitchDownloaderCLI.exe',
    licence: { name: 'MIT', url: 'https://github.com/lay295/TwitchDownloader/blob/master/LICENSE.txt' },
    optional: false,
    needed: () => true
  },
  {
    id: 'whisper-cpu',
    label: 'whisper.cpp (CPU)',
    version: '1.9.4',
    url: `${GH}/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip`,
    sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
    size: 8573270,
    kind: 'zip',
    include: /^Release\/(whisper-cli\.exe|whisper\.dll|ggml[\w-]*\.dll)$/,
    entry: 'Release/whisper-cli.exe',
    licence: { name: 'MIT', url: 'https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE' },
    optional: false,
    needed: () => true
  },
  {
    id: 'whisper-cuda',
    label: 'whisper.cpp (NVIDIA)',
    version: '1.9.4',
    url: `${GH}/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-11.8.0-bin-x64.zip`,
    sha256: '0b29b2175bb17ec26da29677cbc7c467c57d103245144d62a49a703f6bc3fdae',
    size: 272982859,
    kind: 'zip',
    include: /^Release\/(whisper-cli\.exe|whisper\.dll|ggml[\w-]*\.dll|cu\w+64_\d+\.dll)$/,
    entry: 'Release/whisper-cli.exe',
    licence: {
      name: 'MIT',
      url: 'https://github.com/ggml-org/whisper.cpp/blob/master/LICENSE',
      note: 'Includes NVIDIA CUDA runtime libraries under the NVIDIA CUDA EULA'
    },
    optional: false,
    needed: (hw) => hw.whisper === 'cuda'
  },
  {
    id: 'llama',
    label: 'llama.cpp',
    version: 'b11236',
    url: `${GH}/ggml-org/llama.cpp/releases/download/b11236/llama-b11236-bin-win-vulkan-x64.zip`,
    sha256: '8e9f9ad6acda2ad2ad895ac91d876f86ab11123de906d74bbc1a35d13d8a3bd3',
    size: 33064176,
    kind: 'zip',
    include: /^(llama-server\.exe|[\w-]+\.dll|LICENSE[\w.-]*)$/,
    entry: 'llama-server.exe',
    licence: { name: 'MIT', url: 'https://github.com/ggml-org/llama.cpp/blob/master/LICENSE' },
    optional: true,
    needed: () => true
  },
  {
    id: 'model-whisper-large',
    label: 'Speech model (Whisper large-v3-turbo)',
    version: 'q8_0',
    url: `${HF}/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q8_0.bin`,
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
    size: 874188075,
    kind: 'file',
    entry: 'ggml-large-v3-turbo-q8_0.bin',
    licence: { name: 'MIT', url: 'https://github.com/openai/whisper/blob/main/LICENSE', note: 'OpenAI Whisper weights, ggml conversion' },
    optional: false,
    needed: (hw) => hw.whisper === 'cuda'
  },
  {
    id: 'model-whisper-small',
    label: 'Speech model (Whisper small)',
    version: 'q8_0',
    url: `${HF}/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q8_0.bin`,
    sha256: '49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f',
    size: 264464607,
    kind: 'file',
    entry: 'ggml-small-q8_0.bin',
    licence: { name: 'MIT', url: 'https://github.com/openai/whisper/blob/main/LICENSE', note: 'OpenAI Whisper weights, ggml conversion' },
    optional: false,
    // Also on GPU machines: if the GPU fails, the CPU fallback needs a small model.
    needed: () => true
  },
  {
    id: 'model-vad',
    label: 'Voice detection model (Silero VAD)',
    version: '6.2.0',
    url: `${HF}/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin`,
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
    size: 885098,
    kind: 'file',
    entry: 'ggml-silero-v6.2.0.bin',
    licence: { name: 'MIT', url: 'https://github.com/snakers4/silero-vad/blob/master/LICENSE' },
    optional: false,
    needed: () => true
  },
  {
    id: 'model-llm-9b',
    label: 'Language model (Qwen3.5 9B)',
    version: 'Q4_K_M-3885219',
    // No official GGUF from the Qwen org for this size (only safetensors at
    // huggingface.co/Qwen/Qwen3.5-9B); unsloth's is the pinned quantization.
    url: `${HF}/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf`,
    sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
    size: 5680522464,
    kind: 'file',
    entry: 'Qwen3.5-9B-Q4_K_M.gguf',
    licence: { name: 'Apache-2.0', url: 'https://huggingface.co/Qwen/Qwen3.5-9B', note: 'unsloth GGUF quantization of the official Qwen weights' },
    optional: true,
    needed: (hw) => canRunBigLlm(hw)
  },
  {
    id: 'model-llm-8b',
    label: 'Language model (Ministral 3 8B)',
    version: '2512-Q4_K_M',
    url: `${HF}/mistralai/Ministral-3-8B-Instruct-2512-GGUF/resolve/0102285ad796bd99af90f58de616092e5630e970/Ministral-3-8B-Instruct-2512-Q4_K_M.gguf`,
    sha256: '33e7a72cf5e6e2cfc2f2847075acc013d68bba023e35310cef86b5cf8fdca761',
    size: 5198911904,
    kind: 'file',
    entry: 'Ministral-3-8B-Instruct-2512-Q4_K_M.gguf',
    licence: { name: 'Apache-2.0', url: 'https://huggingface.co/mistralai/Ministral-3-8B-Instruct-2512-GGUF' },
    optional: true,
    // Replaced by model-llm-9b (Qwen3.5 9B rated much better in testing at
    // the same speed): never fetched fresh, only recognised so an existing
    // install can keep working until the new model is downloaded.
    needed: () => false,
    deprecated: true
  },
  {
    id: 'model-llm-3b',
    label: 'Language model (Ministral 3 3B)',
    version: '2512-Q4_K_M',
    url: `${HF}/mistralai/Ministral-3-3B-Instruct-2512-GGUF/resolve/eb599d408350ea2bb60452cb86be7c7b2fc28227/Ministral-3-3B-Instruct-2512-Q4_K_M.gguf`,
    sha256: '9ed150d4367e68df0ac8e1540f6ddc65b42d0ee26378329d1ecbca60f93fc5f8',
    size: 2147023008,
    kind: 'file',
    entry: 'Ministral-3-3B-Instruct-2512-Q4_K_M.gguf',
    licence: { name: 'Apache-2.0', url: 'https://huggingface.co/mistralai/Ministral-3-3B-Instruct-2512-GGUF' },
    optional: true,
    needed: (hw) => !canRunBigLlm(hw)
  },
  {
    id: 'separator',
    label: 'Voice separator (demucs.cpp)',
    version: 'tools-separator-1',
    url: `${GH}/jypy933/crapcut/releases/download/tools-separator-1/crapcut-separator-win-x64.zip`,
    sha256: 'a174d7b52de856b01f1ea1b0d92a6c85136048d9bfe3b22f1ea71ce4c12a1a57',
    size: 2102181,
    kind: 'zip',
    include: /^(crapcut-separate(-sse2)?\.exe|LICENSE-[\w.-]+\.txt)$/,
    entry: 'crapcut-separate.exe',
    licence: {
      name: 'MIT',
      url: 'https://github.com/sevagh/demucs.cpp/blob/main/LICENSE',
      note: 'Built by CrapCut CI from demucs.cpp; includes Eigen (MPL-2.0) and libnyquist (BSD-2-Clause)'
    },
    optional: true,
    needed: () => true
  },
  {
    id: 'model-demucs',
    label: 'Voice separation model (Demucs htdemucs)',
    version: 'htdemucs-4s-f16',
    url: `${GH}/jypy933/crapcut/releases/download/tools-separator-1/ggml-model-htdemucs-4s-f16.bin`,
    sha256: '72b17c42d308982ddb5069bc3bf48b81a5aac4cb6516e4366c0fa7cef6df0064',
    size: 83994361,
    kind: 'file',
    entry: 'ggml-model-htdemucs-4s-f16.bin',
    licence: { name: 'MIT', url: 'https://github.com/facebookresearch/demucs/blob/main/LICENSE', note: "Meta's official weights, converted by CrapCut CI" },
    optional: true,
    needed: () => true
  }
]

/** Hosts downloads may come from (after redirects). */
export const DOWNLOAD_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'cas-bridge.xethub.hf.co'
]

export function isAllowedDownloadUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' || u.username || u.password) return false
    const host = u.hostname.toLowerCase()
    return DOWNLOAD_HOSTS.includes(host) || host.endsWith('.hf.co') || host.endsWith('.huggingface.co')
  } catch {
    return false
  }
}

export function artifact(id: ToolId): Artifact {
  const a = ARTIFACTS.find((x) => x.id === id)
  if (!a) throw new Error(`unknown tool ${id}`)
  return a
}

export function neededArtifacts(hw: HardwareProfile): Artifact[] {
  return ARTIFACTS.filter((a) => a.needed(hw))
}

/** Licence notices for tools that are not downloaded but ship inside the app. */
export const BUNDLED_NOTICES = [
  { name: 'Electron', version: '44', licence: 'MIT', url: 'https://github.com/electron/electron/blob/main/LICENSE', note: 'Includes Chromium and Node.js' },
  { name: 'React', version: '19', licence: 'MIT', url: 'https://github.com/facebook/react/blob/main/LICENSE', note: null },
  { name: 'Lucide icons', version: '1', licence: 'ISC', url: 'https://github.com/lucide-icons/lucide/blob/main/LICENSE', note: null },
  { name: 'Zod', version: '4', licence: 'MIT', url: 'https://github.com/colinhacks/zod/blob/main/LICENSE', note: null },
  { name: 'electron-updater', version: '6', licence: 'MIT', url: 'https://github.com/electron-userland/electron-builder/blob/master/LICENSE', note: null },
  { name: 'yauzl', version: '3', licence: 'MIT', url: 'https://github.com/thejoshwolfe/yauzl/blob/master/LICENSE', note: null },
  { name: 'Montserrat font', version: '8', licence: 'OFL-1.1', url: 'https://github.com/JulietaUla/Montserrat/blob/master/OFL.txt', note: 'Caption font' }
] as const
