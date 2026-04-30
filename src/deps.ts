import { renderLlamaInstallHint } from './distro.js';
import type { Config } from './types.js';
import { have } from './util.js';

export function requirePi(): void {
  if (have('pi')) return;
  console.error(`locca: 'pi' (coding agent) not found in PATH.

The 'pi' subcommand requires the pi CLI. Install it with:
  npm install -g @mariozechner/pi-coding-agent
or via mise:
  mise use -g npm:@mariozechner/pi-coding-agent

Docs: https://pi.dev  |  Source: https://github.com/badlogic/pi-mono

If you only want serve/chat/bench, use those subcommands — they don't
need pi.`);
  process.exit(1);
}

export function requireLlama(cfg: Config): void {
  if (have(cfg.llamaServer)) return;
  console.error(`locca: '${cfg.llamaServer}' not found in PATH.

${renderLlamaInstallHint()}

If you built llama.cpp elsewhere, set llamaServer / llamaCli in
~/.locca/config.json to absolute paths.`);
  process.exit(1);
}
