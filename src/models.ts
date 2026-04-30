import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import search from '@inquirer/search';
import type { Model } from './types.js';
import { formatGB } from './util.js';

export function scanModels(modelsDir: string): Model[] {
  const out: Model[] = [];
  walk(modelsDir, (path) => {
    const name = basename(path);
    if (!name.endsWith('.gguf')) return;
    if (name.startsWith('mmproj')) return;
    // Tokenizer test fixtures from llama.cpp's source tree — they're GGUFs
    // but contain no weights, so they're not chattable.
    if (name.startsWith('ggml-vocab-')) return;

    const dir = dirname(path);
    let mmproj: string | undefined;
    try {
      const sibling = readdirSync(dir).find(
        (f) => f.startsWith('mmproj') && f.endsWith('.gguf'),
      );
      if (sibling) mmproj = join(dir, sibling);
    } catch {
      // ignore
    }

    let sizeBytes = 0;
    try {
      sizeBytes = statSync(path).size;
    } catch {
      // ignore
    }

    out.push({
      name: name.replace(/\.gguf$/, ''),
      path,
      dir,
      sizeBytes,
      sizeGB: sizeBytes / 1024 / 1024 / 1024,
      hasVision: Boolean(mmproj),
      mmprojPath: mmproj,
    });
  });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function walk(dir: string, fn: (path: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let s;
    try {
      // statSync follows symlinks (matches `find -L` behaviour in the bash version)
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, fn);
    else if (s.isFile()) fn(full);
  }
}

export function modelLine(m: Model): string {
  const tag = m.hasVision ? ' [vision]' : '';
  return `${m.name.padEnd(48)}  ${formatGB(m.sizeBytes).padStart(6)} GB${tag}`;
}

export async function pickModel(
  models: Model[],
  message = 'Pick a model',
): Promise<Model | null> {
  if (models.length === 0) return null;
  const choice = await search<string>({
    message,
    source: async (input) => {
      const q = (input ?? '').toLowerCase();
      return models
        .filter((m) => !q || m.name.toLowerCase().includes(q))
        .map((m) => ({ name: modelLine(m), value: m.path }));
    },
  });
  return models.find((m) => m.path === choice) ?? null;
}

export function findFirstMatch(models: Model[], pattern: string): Model | null {
  const q = pattern.toLowerCase();
  return models.find((m) => m.name.toLowerCase().includes(q)) ?? null;
}

// Per-model context override — picked by name match.
// MoE / hybrid-attention models tolerate big ctx (small per-token KV).
// Dense models hit VRAM hard above ~32k.
//
// The size-class regexes use word-boundary-ish anchors so e.g. "Qwen3.5-9B"
// doesn't accidentally match "32B". Order matters — bigger sizes first.
//
// `vramBudgetMB`, when provided, caps the result so a small GPU doesn't
// OOM on the 128k default. It's a tier ceiling, not a precise estimate —
// see `ctxCapForBudget()`.
export function ctxForModel(name: string, vramBudgetMB?: number): number {
  let ctx: number;
  if (/A3B|MoE|moe/i.test(name)) ctx = 131072;
  else if (/(?<![0-9])(35B|32B|30B)(?![0-9])/.test(name)) ctx = 65536;
  else if (/(?<![0-9])(27B|24B|22B)(?![0-9])/.test(name)) ctx = 32768;
  else if (/(?<![0-9])(14B|13B|12B)(?![0-9])/.test(name)) ctx = 65536;
  else if (/(?<![0-9])([3-9]B|7B)(?![0-9])/.test(name)) ctx = 131072;
  else ctx = 32768;

  const cap = ctxCapForBudget(vramBudgetMB);
  return cap !== undefined && ctx > cap ? cap : ctx;
}

// Conservative ceiling for the auto-picked ctx given a VRAM budget. The
// numbers assume the server's q8_0 KV-cache defaults — they're meant to
// keep load-time OOM at bay on smaller GPUs, not to maximise utilisation.
// Users who want more can set `defaultCtx` explicitly or pass ctx to
// `pi-llm serve`.
export function ctxCapForBudget(vramBudgetMB?: number): number | undefined {
  if (!vramBudgetMB || vramBudgetMB <= 0) return undefined;
  if (vramBudgetMB <= 6 * 1024) return 8192;
  if (vramBudgetMB <= 8 * 1024) return 16384;
  if (vramBudgetMB <= 12 * 1024) return 32768;
  if (vramBudgetMB <= 16 * 1024) return 65536;
  return 131072;
}
