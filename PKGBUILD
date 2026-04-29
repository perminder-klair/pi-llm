# Maintainer: Perminder Klair <perminder.klair@gmail.com>
pkgname=pi-llm
pkgver=0.1.0
pkgrel=1
pkgdesc="TUI for managing local LLM inference with llama.cpp (gum-based)"
arch=('any')
url="https://github.com/perminder-klair/pi-llm"
license=('MIT')
depends=(
    'bash'
    'gum'
    'curl'
    'jq'
    'python'
    'llama.cpp'
)
optdepends=(
    'rocm-smi-lib: VRAM monitoring on AMD GPUs'
    'vulkan-tools: Vulkan device introspection'
)
source=("$pkgname" 'LICENSE' 'README.md')
sha256sums=('SKIP' 'SKIP' 'SKIP')

package() {
    install -Dm755 "$srcdir/pi-llm"   "$pkgdir/usr/bin/pi-llm"
    install -Dm644 "$srcdir/LICENSE"  "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
    install -Dm644 "$srcdir/README.md" "$pkgdir/usr/share/doc/$pkgname/README.md"
}
