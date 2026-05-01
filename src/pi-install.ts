import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { pc } from './ui.js';
import { have } from './util.js';

export const PI_PKG = '@mariozechner/pi-coding-agent';

export function renderPiInstallHint(): string {
  return [
    'Install pi with:',
    `  ${pc.cyan(`npm install -g ${PI_PKG}`)}`,
    'or via mise:',
    `  ${pc.cyan(`mise use -g npm:${PI_PKG}`)}`,
    '',
    pc.dim('On Debian/Ubuntu the system nodejs may be too old — consider mise or NodeSource.'),
  ].join('\n');
}

export async function tryInstallPi(): Promise<boolean> {
  if (have('mise')) {
    const r = spawnSync('mise', ['use', '-g', `npm:${PI_PKG}`], {
      stdio: 'inherit',
    });
    if (r.status === 0) {
      p.log.success('Installed pi via mise');
      return true;
    }
    p.log.warn('mise install failed, trying npm...');
  }

  if (have('npm')) {
    const r = spawnSync('npm', ['install', '-g', PI_PKG], { stdio: 'inherit' });
    if (r.status === 0) {
      p.log.success('Installed pi via npm');
      return true;
    }
    p.log.warn('npm install failed (may need sudo, or use a Node version manager).');
  } else {
    p.log.warn('Neither mise nor npm found.');
  }

  p.log.message(renderPiInstallHint());
  return false;
}
