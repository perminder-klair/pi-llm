#!/bin/bash
# pi-llm interactive installer
# Bootstraps deps, asks for paths/defaults, writes config, installs the binary.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/pi-llm"
CONFIG_FILE="$CONFIG_DIR/config"

have() { command -v "$1" >/dev/null 2>&1; }

is_arch() { [[ -f /etc/arch-release ]] || have pacman; }

# ── 1. Bootstrap gum (the rest of the installer uses gum) ──────────────
ensure_gum() {
    have gum && return 0
    echo "pi-llm installer needs 'gum' for the interactive UI."
    if is_arch; then
        read -rp "Install gum via pacman now? [y/N] " ans
        case "$ans" in
            y|Y|yes) sudo pacman -S --needed gum ;;
            *) echo "Aborting — install gum, then re-run."; exit 1 ;;
        esac
    else
        echo "This installer is tuned for Arch Linux. Install gum manually:"
        echo "  https://github.com/charmbracelet/gum"
        exit 1
    fi
}

ensure_gum

banner() {
    gum style \
        --foreground 212 --bold \
        --border rounded --border-foreground 240 \
        --padding "1 3" --margin "1 0" \
        "pi-llm installer" "" "Local LLM inference manager for llama.cpp"
}

note()  { gum style --foreground 240 "  $*"; }
ok()    { gum style --foreground 78  "✓ $*"; }
warn()  { gum style --foreground 214 "! $*"; }
err()   { gum style --foreground 196 "✗ $*"; }

# ── 2. Dependency check ────────────────────────────────────────────────
# Required (pacman-installable) deps for the TUI itself.
check_deps() {
    gum style --foreground 212 --bold "Checking core dependencies"
    local -a missing_pkg=()
    local -a missing_cmd=()

    declare -A CMD_TO_PKG=(
        [bash]=bash
        [curl]=curl
        [jq]=jq
        [python3]=python
    )

    for cmd in bash curl jq python3; do
        if have "$cmd"; then
            ok "$cmd"
        else
            missing_cmd+=("$cmd")
            missing_pkg+=("${CMD_TO_PKG[$cmd]}")
        fi
    done

    if [[ ${#missing_cmd[@]} -eq 0 ]]; then
        return 0
    fi

    warn "Missing: ${missing_cmd[*]}"
    if ! is_arch; then
        err "Not on Arch — install ${missing_pkg[*]} manually then re-run."
        exit 1
    fi
    if gum confirm "Install via pacman: ${missing_pkg[*]}?"; then
        sudo pacman -S --needed "${missing_pkg[@]}"
    else
        err "Aborting — required dependencies missing."
        exit 1
    fi
}

# llama.cpp can come from the official repo, AUR variants, or a source build.
# We only check that the binaries exist; we don't force a specific package.
check_llamacpp() {
    gum style --foreground 212 --bold "llama.cpp"
    if have llama-server && have llama-cli; then
        ok "llama-server: $(command -v llama-server)"
        ok "llama-cli:    $(command -v llama-cli)"
        return 0
    fi
    warn "llama-server / llama-cli not found in PATH."
    note "Install one of:"
    note "  sudo pacman -S llama.cpp                # official Arch package"
    note "  yay -S llama.cpp-vulkan-git             # AUR (Vulkan / Radeon)"
    note "  yay -S llama.cpp-hip-git                # AUR (ROCm / HIP)"
    note "  build from source: https://github.com/ggml-org/llama.cpp"
    note ""
    note "If you build from source, add the build/bin dir to PATH or set"
    note "LLAMA_SERVER / LLAMA_CLI to absolute paths in $CONFIG_FILE."
    if is_arch && gum confirm --default=no "Try 'sudo pacman -S llama.cpp' now?"; then
        sudo pacman -S --needed llama.cpp || warn "pacman install failed — install manually."
    fi
}

# ── 3. Optional deps (rocm-smi, vulkan-tools, gum already done) ────────
check_optional() {
    gum style --foreground 212 --bold "Optional tools"
    have rocm-smi && ok "rocm-smi (AMD VRAM monitoring)" || note "rocm-smi missing (optional, AMD only)"
    have vulkaninfo && ok "vulkaninfo" || note "vulkan-tools missing (optional)"
}

# ── 4. Models directory ────────────────────────────────────────────────
configure_models() {
    gum style --foreground 212 --bold "Models directory"
    local default="$HOME/.lmstudio/models"
    local existing=""
    [[ -f "$CONFIG_FILE" ]] && existing=$(grep -oP '^MODELS_DIR="\K[^"]+' "$CONFIG_FILE" 2>/dev/null || echo "")
    local current="${existing:-$default}"

    MODELS_DIR=$(gum input \
        --header "Where do you keep .gguf models?" \
        --placeholder "$current" \
        --value "$current" \
        --width 70)
    MODELS_DIR="${MODELS_DIR:-$current}"
    # Expand leading ~
    MODELS_DIR="${MODELS_DIR/#\~/$HOME}"

    if [[ ! -d "$MODELS_DIR" ]]; then
        if gum confirm "Directory does not exist. Create $MODELS_DIR ?"; then
            mkdir -p "$MODELS_DIR"
            ok "Created $MODELS_DIR"
        else
            warn "Skipped — pi-llm will fail until this directory exists."
        fi
    fi

    local count=0
    if [[ -d "$MODELS_DIR" ]]; then
        count=$(find -L "$MODELS_DIR" -name "*.gguf" ! -name "mmproj*" 2>/dev/null | wc -l)
    fi
    ok "Models dir: $MODELS_DIR  ($count GGUF model$([[ $count -eq 1 ]] || echo s) found)"
}

# ── 5. Server defaults ─────────────────────────────────────────────────
configure_server() {
    gum style --foreground 212 --bold "Server defaults"
    if gum confirm --default=yes "Use sensible defaults? (port 8080, ctx 32768, threads 10)"; then
        DEFAULT_PORT=8080
        DEFAULT_CTX=32768
        DEFAULT_THREADS=10
    else
        DEFAULT_PORT=$(gum input --header "Port"          --value "8080"  --width 20)
        DEFAULT_CTX=$(gum input  --header "Context size"  --value "32768" --width 20)
        DEFAULT_THREADS=$(gum input --header "CPU threads" --value "10"   --width 20)
        DEFAULT_PORT="${DEFAULT_PORT:-8080}"
        DEFAULT_CTX="${DEFAULT_CTX:-32768}"
        DEFAULT_THREADS="${DEFAULT_THREADS:-10}"
    fi
    ok "Port $DEFAULT_PORT  |  ctx $DEFAULT_CTX  |  threads $DEFAULT_THREADS"
}

# ── 6. Optional pi (coding agent) check ────────────────────────────────
check_pi() {
    gum style --foreground 212 --bold "pi (coding agent)"
    if have pi; then
        ok "pi found: $(command -v pi)"
        return 0
    fi
    note "pi powers the 'pi-llm pi' coding-agent subcommand."
    note "Project: https://pi.dev  |  Source: https://github.com/badlogic/pi-mono"
    if ! gum confirm --default=yes "Install pi now?"; then
        note "Skipped. To install manually later:"
        note "  npm install -g @mariozechner/pi-coding-agent"
        return 0
    fi

    local pkg="@mariozechner/pi-coding-agent"

    # Prefer mise (isolated tool versions) → fall back to npm → fall back to hints.
    if have mise; then
        if mise use -g "npm:$pkg"; then
            ok "Installed via mise"
            return 0
        fi
        warn "mise install failed, trying npm..."
    fi

    if have npm; then
        if npm install -g "$pkg"; then
            ok "Installed via npm"
            return 0
        fi
        warn "npm install failed (may need sudo or a Node version manager)."
    else
        warn "Neither mise nor npm found."
        if is_arch && gum confirm --default=yes "Install nodejs-lts + npm via pacman?"; then
            sudo pacman -S --needed nodejs-lts npm && \
                npm install -g "$pkg" && \
                ok "Installed pi via npm" && return 0
        fi
    fi

    note "Manual install command:"
    note "  npm install -g $pkg"
}

# ── 7. Write config file ───────────────────────────────────────────────
write_config() {
    gum style --foreground 212 --bold "Writing config"
    mkdir -p "$CONFIG_DIR"
    cat > "$CONFIG_FILE" <<EOF
# pi-llm config — written by installer on $(date -I)
# Edit by hand or re-run install.sh.

MODELS_DIR="$MODELS_DIR"
DEFAULT_PORT=$DEFAULT_PORT
DEFAULT_CTX=$DEFAULT_CTX
DEFAULT_THREADS=$DEFAULT_THREADS
LLAMA_SERVER="llama-server"
LLAMA_CLI="llama-cli"
EOF
    ok "Wrote $CONFIG_FILE"
}

# ── 8. Install the binary ──────────────────────────────────────────────
install_binary() {
    gum style --foreground 212 --bold "Install pi-llm"
    local method
    method=$(gum choose \
        "Build & install Arch package (makepkg -si)" \
        "Symlink to ~/.local/bin/pi-llm  (no root, dev-friendly)" \
        "Skip — I will install manually")

    case "$method" in
        Build*)
            if ! is_arch; then err "Not on Arch — pick symlink instead."; return; fi
            (cd "$REPO_DIR" && makepkg -si)
            ok "Installed via pacman."
            ;;
        Symlink*)
            mkdir -p "$HOME/.local/bin"
            ln -sf "$REPO_DIR/pi-llm" "$HOME/.local/bin/pi-llm"
            ok "Symlinked $REPO_DIR/pi-llm → $HOME/.local/bin/pi-llm"
            case ":$PATH:" in
                *":$HOME/.local/bin:"*) ;;
                *) warn "$HOME/.local/bin is not in \$PATH — add it to your shell rc." ;;
            esac
            ;;
        Skip*)
            note "Run pi-llm directly from the repo: $REPO_DIR/pi-llm"
            ;;
    esac
}

# ── main ───────────────────────────────────────────────────────────────
banner
check_deps
echo ""
check_llamacpp
echo ""
check_optional
echo ""
configure_models
echo ""
configure_server
echo ""
check_pi
echo ""
write_config
echo ""
install_binary
echo ""
gum style --foreground 78 --bold --border rounded --padding "0 2" "Done. Run: pi-llm"
