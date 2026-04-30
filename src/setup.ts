import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import * as p from '@clack/prompts';
import { download } from './commands/download.js';
import { searchHF } from './commands/search.js';
import { CONFIG_FILE, loadConfig, saveConfig } from './config.js';
import { detectDistro, renderLlamaInstallHint } from './distro.js';
import { scanModels } from './models.js';
import { probeServer } from './server.js';
import { exitIfCancelled, pc } from './ui.js';
import { autoThreads, expandHome, have } from './util.js';

export async function runSetup(): Promise<void> {
  p.intro(pc.magenta(pc.bold('locca setup')));

  const existing = loadConfig();
  const totalCores = autoThreads() + 2; // autoThreads = nproc - 2
  const threadDefault = autoThreads();

  // Models directory
  const modelsDirIn = await p.text({
    message: 'Where do you keep .gguf models?',
    placeholder: existing.modelsDir,
    initialValue: existing.modelsDir,
  });
  exitIfCancelled(modelsDirIn);
  const modelsDir = expandHome(modelsDirIn || existing.modelsDir);

  if (!existsSync(modelsDir)) {
    const create = await p.confirm({
      message: `Directory does not exist. Create ${modelsDir}?`,
      initialValue: true,
    });
    exitIfCancelled(create);
    if (create) {
      mkdirSync(modelsDir, { recursive: true });
      p.log.success(`Created ${modelsDir}`);
    } else {
      p.log.warn('Skipped — locca will fail until this directory exists.');
    }
  }

  // ── llama.cpp source: spawn locally vs use an existing server ───────
  const llamaPresent = have('llama-server');
  const distro = detectDistro();

  const sourceLabel = llamaPresent
    ? `llama-server is on PATH — locca will spawn it for you (detected ${distro.prettyName})`
    : `llama-server NOT found in PATH (detected ${distro.prettyName})`;
  p.log.message(sourceLabel);

  type Source = 'local' | 'external';
  const defaultSource: Source = llamaPresent ? 'local' : 'external';
  const source = await p.select<Source>({
    message: 'How should locca reach llama.cpp?',
    initialValue: defaultSource,
    options: [
      {
        value: 'local',
        label: 'Local — locca spawns llama-server when needed',
        hint: llamaPresent ? '' : 'requires llama-server on PATH',
      },
      {
        value: 'external',
        label: 'External — locca connects to a server you already run',
        hint: 'e.g. another machine on your LAN, or a server you start yourself',
      },
    ],
  });
  exitIfCancelled(source);

  let serverUrl: string | undefined;
  if (source === 'external') {
    serverUrl = await promptForExternalServer(existing.serverUrl);
  }

  // Server defaults (port/ctx/threads — relevant for `local`; for `external`
  // they're still useful as fallbacks but mostly cosmetic).
  const useDefaults = await p.confirm({
    message: `Use sensible defaults? (port 8080, ctx 32768, threads ${threadDefault} of ${totalCores} cores)`,
    initialValue: true,
  });
  exitIfCancelled(useDefaults);

  let port = 8080;
  let ctx = 32768;
  let threads = threadDefault;

  if (!useDefaults) {
    const portIn = await p.text({ message: 'Port', initialValue: '8080' });
    exitIfCancelled(portIn);
    port = parseInt(portIn, 10) || 8080;

    const ctxIn = await p.text({ message: 'Context size', initialValue: '32768' });
    exitIfCancelled(ctxIn);
    ctx = parseInt(ctxIn, 10) || 32768;

    const threadsIn = await p.text({
      message: `CPU threads (system has ${totalCores})`,
      initialValue: String(threadDefault),
    });
    exitIfCancelled(threadsIn);
    threads = parseInt(threadsIn, 10) || threadDefault;
  }

  // VRAM budget — caps auto-picked ctx so small GPUs don't OOM on 128k.
  // Stored in MB; `undefined` means no cap (current behaviour).
  const vramBudgetMB = await promptForVramBudget(existing.vramBudgetMB);

  // pi skills / extensions — off by default (locca passes --no-skills /
  // --no-extensions). Enable for users who want pi's full agentic surface.
  const piSkills = await p.confirm({
    message: "Enable pi's built-in skills?",
    initialValue: existing.piSkills ?? false,
  });
  exitIfCancelled(piSkills);

  const piExtensions = await p.confirm({
    message: "Enable pi's extensions?",
    initialValue: existing.piExtensions ?? false,
  });
  exitIfCancelled(piExtensions);

  saveConfig({
    modelsDir,
    defaultPort: port,
    defaultCtx: ctx,
    defaultThreads: threads,
    serverUrl,
    vramBudgetMB,
    piSkills,
    piExtensions,
  });
  p.log.success(`Wrote ${CONFIG_FILE}`);

  if (source === 'local' && !llamaPresent) {
    p.log.warn('llama-server is not yet on PATH.');
    p.log.message(renderLlamaInstallHint());
    p.log.message(
      `If you built it elsewhere, set llamaServer/llamaCli in ${CONFIG_FILE} to absolute paths.`,
    );
  }

  // Offer to grab a starter model when the modelsDir is empty and the user
  // is going to spawn locally — without weights they can't actually run
  // anything, and discovering `locca download` on their own is friction.
  if (source === 'local' && scanModels(modelsDir).length === 0) {
    await promptForFirstModel();
  }

  // pi (coding agent)
  if (have('pi')) {
    p.log.success('pi (coding agent) found');
  } else {
    const installPi = await p.confirm({
      message: "Install 'pi' coding agent now?",
      initialValue: true,
    });
    exitIfCancelled(installPi);
    if (installPi) await tryInstallPi();
  }

  p.outro(pc.green('Setup complete. Run `locca` to get started.'));
}

async function promptForVramBudget(
  existing: number | undefined,
): Promise<number | undefined> {
  const initial = existing ?? 0;
  const choice = await p.select<number>({
    message: 'Approximate VRAM budget? (caps auto-picked context window)',
    initialValue: initial,
    options: [
      { value: 0, label: 'Skip / unlimited', hint: 'no cap on auto-picked ctx' },
      { value: 6 * 1024, label: '6 GB', hint: 'caps ctx to 8k' },
      { value: 8 * 1024, label: '8 GB', hint: 'caps ctx to 16k' },
      { value: 12 * 1024, label: '12 GB', hint: 'caps ctx to 32k' },
      { value: 16 * 1024, label: '16 GB', hint: 'caps ctx to 64k (Strix Halo class)' },
      { value: 24 * 1024, label: '24 GB or more', hint: 'no cap (full 128k)' },
    ],
  });
  exitIfCancelled(choice);
  return choice > 0 ? choice : undefined;
}

async function promptForExternalServer(
  existingUrl: string | undefined,
): Promise<string> {
  while (true) {
    const urlIn = await p.text({
      message: 'URL of your llama.cpp server',
      placeholder: existingUrl ?? 'http://localhost:8081',
      initialValue: existingUrl ?? 'http://localhost:8081',
      validate: (v) => {
        if (!v) return 'URL is required';
        try {
          const u = new URL(v);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return 'URL must be http:// or https://';
          }
        } catch {
          return 'Not a valid URL';
        }
        return undefined;
      },
    });
    exitIfCancelled(urlIn);
    const url = urlIn.trim().replace(/\/$/, '');

    const spinner = p.spinner();
    spinner.start(`Probing ${url}/health ...`);
    const probe = await probeServer(url, 3000);
    if (probe.alive) {
      spinner.stop(
        probe.model
          ? `Server is reachable (loaded model: ${probe.model})`
          : 'Server is reachable',
      );
      return url;
    }
    spinner.stop('Could not reach server');
    const retry = await p.select<'retry' | 'save' | 'cancel'>({
      message: 'How do you want to proceed?',
      options: [
        { value: 'retry', label: 'Try a different URL' },
        { value: 'save', label: 'Save anyway (server may not be up yet)' },
        { value: 'cancel', label: 'Cancel setup' },
      ],
    });
    exitIfCancelled(retry);
    if (retry === 'save') return url;
    if (retry === 'cancel') process.exit(0);
    // else retry loop
  }
}

async function promptForFirstModel(): Promise<void> {
  p.log.message('Your models directory is empty — locca needs a .gguf to run.');

  type Choice = 'gemma-e2b' | 'qwen-9b' | 'qwen-moe' | 'browse' | 'skip';
  const choice = await p.select<Choice>({
    message: 'Grab a starter model now?',
    initialValue: 'gemma-e2b',
    options: [
      {
        value: 'gemma-e2b',
        label: 'Gemma 4 E2B IT       — tiny, runs almost anywhere',
        hint: 'smallest; good first model',
      },
      {
        value: 'qwen-9b',
        label: 'Qwen3.5 9B           — strong general / coding',
        hint: '~6 GB at Q4; fits 8 GB VRAM',
      },
      {
        value: 'qwen-moe',
        label: 'Qwen3.6 35B-A3B MoE  — flagship, 3B active',
        hint: 'big download but fast inference; needs ~20 GB',
      },
      { value: 'browse', label: 'Browse HuggingFace…', hint: 'search by name' },
      { value: 'skip', label: 'Skip — add models later with `locca download`' },
    ],
  });
  exitIfCancelled(choice);

  if (choice === 'skip') {
    p.log.message('Add a model anytime with `locca download <repo>` or `locca search`.');
    return;
  }

  try {
    if (choice === 'gemma-e2b') {
      await download(['unsloth/gemma-4-E2B-it-GGUF']);
    } else if (choice === 'qwen-9b') {
      await download(['unsloth/Qwen3.5-9B-GGUF']);
    } else if (choice === 'qwen-moe') {
      await download(['unsloth/Qwen3.6-35B-A3B-GGUF']);
    } else {
      await searchHF([]);
    }
  } catch (e) {
    p.log.warn(`Model download failed: ${(e as Error).message}`);
    p.log.message('You can retry later with `locca download` or `locca search`.');
  }
}

async function tryInstallPi(): Promise<void> {
  const pkg = '@mariozechner/pi-coding-agent';
  if (have('mise')) {
    const r = spawnSync('mise', ['use', '-g', `npm:${pkg}`], { stdio: 'inherit' });
    if (r.status === 0) {
      p.log.success('Installed pi via mise');
      return;
    }
    p.log.warn('mise install failed, trying npm...');
  }

  if (have('npm')) {
    const r = spawnSync('npm', ['install', '-g', pkg], { stdio: 'inherit' });
    if (r.status === 0) {
      p.log.success('Installed pi via npm');
      return;
    }
    p.log.warn('npm install failed (may need sudo, or use a Node version manager).');
  } else {
    p.log.warn('Neither mise nor npm found.');
  }

  p.log.message(
    [
      'Manual install command:',
      `  npm install -g ${pkg}`,
      '',
      'On Debian/Ubuntu the system nodejs may be too old — consider mise or NodeSource.',
    ].join('\n'),
  );
}
