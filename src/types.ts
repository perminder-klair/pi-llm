export interface Config {
  modelsDir: string;
  defaultPort: number;
  defaultCtx: number;
  defaultThreads: number;
  llamaServer: string;
  llamaCli: string;
  llamaBench: string;
  piSkillDir?: string;
  /**
   * Enable pi's built-in skills. Default false — locca passes `--no-skills`
   * to keep pi focused on local-model coding without skill dispatch.
   */
  piSkills?: boolean;
  /**
   * Enable pi's extensions. Default false — locca passes `--no-extensions`
   * for the same reason as `piSkills`.
   */
  piExtensions?: boolean;
  /**
   * Enable pi's AGENTS.md / CLAUDE.md context-file discovery. Default false —
   * locca passes `--no-context-files` so small local models aren't blown out
   * by large project instruction files. Enable for users who want pi's full
   * project-aware surface.
   */
  piContextFiles?: boolean;
  /**
   * Approximate VRAM budget in MB. Caps the context window that
   * `ctxForModel()` auto-picks per model so 128k defaults don't OOM on
   * smaller GPUs. Does NOT override an explicit `defaultCtx` or a ctx
   * the user types into `locca serve`. Leave unset for no cap.
   */
  vramBudgetMB?: number;
}

export interface Model {
  name: string;
  path: string;
  dir: string;
  sizeBytes: number;
  sizeGB: number;
  hasVision: boolean;
  mmprojPath?: string;
}
