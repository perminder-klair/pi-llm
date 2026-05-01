import { spawnSync } from 'node:child_process';
import { freemem, loadavg, totalmem } from 'node:os';
import { have } from './util.js';

/**
 * Build a one-line live-stats hint suitable for spinner messages during
 * long-running operations (bench, prompt eval). Best-effort: `loadavg()`
 * is 0,0,0 on Windows (we don't run there), and the GPU util probe is
 * silently skipped if neither nvidia-smi nor rocm-smi is on PATH.
 */
export function buildStatsLine(prefix: string, startedAt: number): string {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;

  const load1 = loadavg()[0] ?? 0;
  const ramFreeGB = freemem() / 1024 ** 3;
  const ramTotalGB = totalmem() / 1024 ** 3;
  const ramUsedGB = ramTotalGB - ramFreeGB;

  const bits = [
    `${elapsedStr}`,
    `load ${load1.toFixed(2)}`,
    `RAM ${ramUsedGB.toFixed(1)}/${ramTotalGB.toFixed(1)} GB`,
  ];

  const gpu = probeGpuUtil();
  if (gpu) bits.push(gpu);

  return `${prefix}  ${bits.join(' · ')}`;
}

function probeGpuUtil(): string | undefined {
  if (have('nvidia-smi')) {
    const r = spawnSync(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { encoding: 'utf8' },
    );
    if (r.status === 0 && r.stdout) {
      const [util, used, total] = (r.stdout.split('\n')[0] ?? '').split(',').map((s) => s.trim());
      if (util && used && total) {
        const usedGB = (Number(used) / 1024).toFixed(1);
        const totalGB = (Number(total) / 1024).toFixed(1);
        return `GPU ${util}% · VRAM ${usedGB}/${totalGB} GB`;
      }
    }
  }
  if (have('rocm-smi')) {
    const r = spawnSync('rocm-smi', ['--showuse', '--showmemuse', '--csv'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const m = r.stdout.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m) return `GPU ${m[1]}%`;
    }
  }
  return undefined;
}
