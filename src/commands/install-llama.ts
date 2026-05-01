import * as p from '@clack/prompts';
import { loadConfig, saveConfig } from '../config.js';
import {
  type Backend,
  backendOptions,
  detectPlatform,
  fetchLatestRelease,
  installLlama,
  locateBinaries,
  pickAsset,
  pruneOldInstalls,
  removeInstall,
  suggestBackend,
} from '../llama-install.js';
import { exitIfCancelled, header, pc } from '../ui.js';

/** Pick GB or MB based on size — 30 MB binaries shouldn't read as "0.0 GB". */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

interface Args {
  backend?: Backend;
  update?: boolean;
  remove?: boolean;
  yes?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--backend' || a === '-b') {
      const v = argv[++i];
      if (!v) continue;
      out.backend = v as Backend;
    } else if (a.startsWith('--backend=')) {
      out.backend = a.slice('--backend='.length) as Backend;
    } else if (a === '--update' || a === '-u') {
      out.update = true;
    } else if (a === '--remove') {
      out.remove = true;
    } else if (a === '--yes' || a === '-y') {
      out.yes = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`Usage: locca install-llama [options]

Download and install a prebuilt llama.cpp binary from upstream releases
into ~/.locca/bin/llama-cpp/. Updates ~/.locca/config.json so locca
points at the bundled install.

Options:
  -b, --backend <name>   vulkan | cuda | hip | metal | cpu  (default: auto)
  -u, --update           re-install the latest release (replaces current)
      --remove           remove the locca-managed install
  -y, --yes              skip prompts (use auto-picked backend)
  -h, --help             show this help`);
}

export async function installLlamaCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  header('locca · install llama.cpp');

  if (args.remove) {
    await handleRemove();
    return;
  }

  await runInstall(args);
}

async function handleRemove(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.llamaBundled) {
    p.log.message('No locca-managed llama.cpp install found.');
    return;
  }
  const confirm = await p.confirm({
    message: `Remove bundled llama.cpp at ${cfg.llamaBundled.dir}?`,
    initialValue: true,
  });
  exitIfCancelled(confirm);
  if (!confirm) return;

  removeInstall(cfg.llamaBundled.dir);
  saveConfig({
    llamaServer: 'llama-server',
    llamaCli: 'llama-cli',
    llamaBench: 'llama-bench',
    llamaBundled: undefined,
  });
  p.log.success('Removed locca-managed llama.cpp. Falling back to PATH lookup.');
}

async function runInstall(args: Args): Promise<void> {
  const cfg = loadConfig();
  const plat = detectPlatform();

  // Pick backend.
  let backend: Backend;
  if (args.backend) {
    backend = args.backend;
  } else if (args.yes) {
    backend = suggestBackend(plat).backend;
  } else {
    backend = await pickBackend(cfg.llamaBundled?.backend as Backend | undefined);
  }

  // Fetch release.
  const spinner = p.spinner();
  spinner.start('Checking latest llama.cpp release...');
  let release: Awaited<ReturnType<typeof fetchLatestRelease>>;
  try {
    release = await fetchLatestRelease();
  } catch (e) {
    spinner.stop('Could not reach GitHub.');
    p.log.error((e as Error).message);
    return;
  }
  const asset = pickAsset(release, plat, backend);
  if (!asset) {
    spinner.stop(`No ${backend} asset for ${plat.platform}/${plat.arch} in ${release.tag_name}.`);
    p.log.message(
      [
        `Available assets in this release:`,
        ...release.assets.map((a) => `  · ${a.name}`),
        '',
        'Try a different --backend, or install llama.cpp manually for your distro.',
      ].join('\n'),
    );
    return;
  }
  spinner.stop(`${release.tag_name} · ${asset.name} (${formatSize(asset.size)})`);

  // Already up to date?
  if (
    cfg.llamaBundled &&
    cfg.llamaBundled.version === release.tag_name &&
    cfg.llamaBundled.backend === backend &&
    !args.update
  ) {
    p.log.success(`Already on ${release.tag_name} (${backend}). Use --update to reinstall.`);
    return;
  }

  if (!args.yes) {
    const where = `~/.locca/bin/llama-cpp/${release.tag_name}-${backend}`;
    const proceed = await p.confirm({
      message: `Download ${formatSize(asset.size)} to ${where}?`,
      initialValue: true,
    });
    exitIfCancelled(proceed);
    if (!proceed) return;
  }

  console.log();
  console.log(pc.magenta(pc.bold('Downloading...')));
  console.log(`  Asset: ${asset.name}`);

  const startTs = Date.now();
  let lastDraw = 0;
  const installed = await installLlama({
    release,
    backend,
    onProgress: (got, total) => {
      const now = Date.now();
      if (now - lastDraw < 100 && got !== total) return;
      lastDraw = now;
      if (total > 0) {
        const pct = ((got / total) * 100).toFixed(1);
        const speed = (got / 1024 / 1024 / Math.max(1, (now - startTs) / 1000)).toFixed(1);
        process.stdout.write(
          `\r  ${pct.padStart(5)}%  ${formatSize(got)} / ${formatSize(total)}  ${speed} MB/s   `,
        );
      } else {
        process.stdout.write(`\r  ${formatSize(got)}   `);
      }
    },
  });
  process.stdout.write('\n');

  saveConfig({
    llamaServer: installed.serverPath,
    llamaCli: installed.cliPath,
    llamaBench: installed.benchPath,
    llamaBundled: {
      version: installed.version,
      backend: installed.backend,
      dir: installed.dir,
      installedAt: new Date().toISOString(),
    },
  });

  // Tidy old versions/backends so the bin dir doesn't grow unbounded.
  pruneOldInstalls(installed.dir);

  console.log();
  p.log.success(`Installed llama.cpp ${installed.version} (${installed.backend})`);
  p.log.message(
    [
      `  ${pc.dim('server:')}  ${installed.serverPath}`,
      `  ${pc.dim('cli:')}     ${installed.cliPath}`,
      `  ${pc.dim('bench:')}   ${installed.benchPath}`,
      '',
      `  ${pc.dim('config updated.')} Run ${pc.cyan('locca')} to use it.`,
    ].join('\n'),
  );
}

async function pickBackend(current?: Backend): Promise<Backend> {
  const plat = detectPlatform();
  const options = backendOptions(plat);
  const suggestion = suggestBackend(plat);

  const choice = await p.select<Backend>({
    message: 'Which backend?',
    initialValue: current ?? suggestion.backend,
    options: options.map((b) => ({
      value: b,
      label: backendLabel(b),
      hint: b === suggestion.backend ? `recommended — ${suggestion.reason}` : backendHint(b),
    })),
  });
  exitIfCancelled(choice);
  return choice;
}

function backendLabel(b: Backend): string {
  switch (b) {
    case 'vulkan':
      return 'Vulkan  — works on most AMD / Intel / NVIDIA GPUs and iGPUs';
    case 'cuda':
      return 'CUDA    — NVIDIA only, fastest on supported cards';
    case 'hip':
      return 'HIP     — AMD ROCm (discrete cards, supported only)';
    case 'metal':
      return 'Metal   — Apple Silicon';
    case 'cpu':
      return 'CPU     — no GPU acceleration';
  }
}

function backendHint(b: Backend): string {
  switch (b) {
    case 'vulkan':
      return 'broad GPU support';
    case 'cuda':
      return 'NVIDIA only';
    case 'hip':
      return 'AMD ROCm';
    case 'metal':
      return 'Apple Silicon';
    case 'cpu':
      return 'fallback';
  }
}

/**
 * Used by the setup wizard to pick a backend, install it, and persist the
 * config in one shot — without going through the standalone CLI parser.
 * Returns true on success, false if the user cancelled or it failed.
 */
export async function installLlamaInteractive(): Promise<boolean> {
  try {
    await runInstall({});
    // After install, surface to caller whether config now points at a
    // working binary. The caller (setup) usually re-checks anyway.
    const cfg = loadConfig();
    return Boolean(cfg.llamaBundled);
  } catch (e) {
    p.log.error(`Install failed: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Re-export so doctor and other modules can quickly check if a previously
 * recorded bundled install still has its binaries on disk.
 */
export function bundledIntact(): boolean {
  const cfg = loadConfig();
  if (!cfg.llamaBundled) return false;
  return Boolean(locateBinaries(cfg.llamaBundled.dir));
}
