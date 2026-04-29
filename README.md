# pi-llm

A small `gum`-powered TUI around [llama.cpp](https://github.com/ggml-org/llama.cpp)
for running, managing, and benchmarking local GGUF models. Tuned for AMD
Strix Halo / Radeon 890M boxes (Vulkan, q8_0 KV cache, single-slot serving),
but works on any system where `llama-server` and `llama-cli` are on `$PATH`.

## What it does

- `serve` — start `llama-server` with a model picked via fuzzy filter
- `chat` — interactive `llama-cli` conversation
- `pi` — boots a server, then launches the `pi` coding agent against it
- `switch` — stop current server and start a different model
- `bench` — run `llama-bench` against a model
- `download` / `search` — pull GGUFs from HuggingFace
- `info` / `status` / `logs` / `delete` / `stop`

Run `pi-llm` with no arguments for an interactive menu, or `pi-llm help` for the
full command list.

## Defaults baked in

- Vulkan, all GPU layers (`--n-gpu-layers 999`)
- q8_0 KV cache (`--cache-type-k q8_0 --cache-type-v q8_0`)
- Flash-attention on
- `--parallel 1` (full ctx to one slot, no division across requests)
- `--cache-reuse 256` (KV reuse across multi-turn requests)
- `--jinja` (proper chat template handling)
- `--image-min-tokens 1024` when an `mmproj*.gguf` sibling is detected
- Per-model auto-tuned context (MoE → 128k, 27B-class dense → 32k, etc.)

## Install

The fastest path is the interactive installer — it checks deps, asks for the
models directory, sets server defaults, optionally helps with `pi`, writes a
config file, and finally installs the binary (Arch package or symlink).

```bash
git clone https://github.com/perminder-klair/pi-llm.git
cd pi-llm
./install.sh
```

Manual Arch package build:

```bash
cd pi-llm
makepkg -si
```

Manual symlink (no root):

```bash
ln -sf "$PWD/pi-llm" "$HOME/.local/bin/pi-llm"
```

## Configuration

`install.sh` writes `${XDG_CONFIG_HOME:-~/.config}/pi-llm/config`, which the
script sources at startup. Override any of these:

```bash
MODELS_DIR="$HOME/.lmstudio/models"
DEFAULT_PORT=8080
DEFAULT_CTX=32768
DEFAULT_THREADS=10
LLAMA_SERVER="llama-server"
LLAMA_CLI="llama-cli"
```

Re-run `./install.sh` any time to reconfigure, or edit the file directly.

## Dependencies

- `bash`, `gum`, `curl`, `jq`, `python` — runtime
- `llama.cpp` (provides `llama-server`, `llama-cli`, `llama-bench`)
- Optional: `pi` (for the `pi-llm pi` coding-agent integration)
- Optional: `rocm-smi-lib`, `vulkan-tools` — diagnostics

## Per-model context

`pi-llm pi` auto-tunes context size from the model filename via
`ctx_for_model()` (MoE → 128k, 27B-class dense → 32k, etc.). Edit the function
in the script to tune for your own VRAM budget.

## License

MIT
