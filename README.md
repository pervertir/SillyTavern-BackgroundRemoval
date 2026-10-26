# Background Removal for SillyTavern

A SillyTavern server plugin that cuts images out of their background on your own machine.
It runs [ToonOut](https://huggingface.co/joelseytre/toonout), a BiRefNet fine-tuned for
anime that keeps BiRefNet's accuracy on real people, through native ONNX Runtime.

It's what the [Yodayo Tavern Theme](https://github.com/pervertir/SillyTavern-YodayoTavernTheme)
uses for its **Remove background** button, and any extension can call it.

## Install

1. Turn on server plugins: set `enableServerPlugins: true` in SillyTavern's `config.yaml`.
2. In SillyTavern's `plugins` folder:
   ```
   git clone https://github.com/pervertir/SillyTavern-BackgroundRemoval
   cd SillyTavern-BackgroundRemoval
   npm install
   ```
3. Restart SillyTavern. The console shows `[background-removal] ready`.

The first image downloads the model (974 MB) into the plugin's `models` folder. With
`enableServerPluginsAutoUpdate` on, SillyTavern keeps the plugin up to date; run
`npm install` again after an update that changes its dependencies.

## Hardware

The plugin picks the fastest backend this machine has, and falls back to the next one if
a backend fails:

| Backend | Where |
| --- | --- |
| CUDA | Linux x64 with an NVIDIA GPU (CUDA 12) |
| DirectML | Windows, any DirectX 12 GPU (NVIDIA, AMD, Intel) |
| WebGPU | macOS through Metal (Apple silicon), Linux through Vulkan (AMD, Intel) |
| CPU | everywhere else |

CoreML isn't used by default: it splits this model into over 200 parts and needs more than
30 GB of memory. On an Apple M4 a 1024×1024 pass takes about 4 seconds through WebGPU.

The loaded model holds several GB, so it's released after 10 minutes unused.

Environment variables:

- `BGREMOVE_BACKEND`: force one backend (`cuda`, `dml`, `webgpu`, `coreml` or `cpu`).
- `BGREMOVE_MODEL`: path to another BiRefNet-style ONNX model (1024×1024 input).

## API

Under `/api/plugins/background-removal`, with SillyTavern's usual request headers:

- `GET /status`: `{ status, backend, received, total, error, model }`. `status` is `idle`,
  `downloading`, `loading`, `ready` or `error`; `received` and `total` give the model
  download's progress.
- `POST /remove` with `{ image: "<base64>" }` (a data URL works too): returns
  `{ image: "<base64 PNG>", backend }`, the same size as the input, with the background
  transparent.

Requests run one at a time.

## License

MIT. ToonOut and the [ONNX export](https://huggingface.co/sprited/birefnet-toonout-onnx)
used here are MIT too.
