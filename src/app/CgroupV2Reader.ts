import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface CgroupMemoryEvents {
  readonly high: bigint;
  readonly max: bigint;
  readonly oom: bigint;
  readonly oomKill: bigint;
}

export interface CgroupCpuStat {
  readonly usageUsec: bigint;
  readonly userUsec?: bigint;
  readonly systemUsec?: bigint;
}

export interface CgroupSnapshot {
  readonly sampledAtMonotonicMs: number;
  readonly memoryCurrentBytes: bigint;
  readonly memoryMaxBytes?: bigint;
  readonly memoryPeakBytes?: bigint;
  readonly swapCurrentBytes?: bigint;
  readonly pidsCurrent?: bigint;
  readonly events: CgroupMemoryEvents;
  readonly cpu?: CgroupCpuStat;
}

export type CgroupReaderAvailability =
  | { readonly available: true; readonly rootPath: string }
  | { readonly available: false; readonly reason: string };

export interface CgroupFileSystem {
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  access(filePath: string): Promise<void>;
}

export interface CgroupV2ReaderOptions {
  readonly fs?: CgroupFileSystem;
  readonly now?: () => number;
  readonly procSelfCgroupPath?: string;
  readonly procSelfMountinfoPath?: string;
  readonly sysFsCgroupPath?: string;
}

const DEFAULT_EVENTS: CgroupMemoryEvents = {
  high: 0n,
  max: 0n,
  oom: 0n,
  oomKill: 0n,
};

export class CgroupV2UnavailableError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CgroupV2UnavailableError';
  }
}

export class CgroupV2ReadError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CgroupV2ReadError';
  }
}

/**
 * Reads cgroup v2 CPU, memory, and pids counters for the current process tree.
 * Missing optional files are treated as unavailable, not zero.
 */
export class CgroupV2Reader {
  private readonly fs: CgroupFileSystem;
  private readonly now: () => number;
  private readonly procSelfCgroupPath: string;
  private readonly procSelfMountinfoPath: string;
  private readonly sysFsCgroupPath: string;
  private rootPathPromise: Promise<string> | undefined;

  public constructor(options: CgroupV2ReaderOptions = {}) {
    this.fs = options.fs ?? {
      readFile: (filePath, encoding) => readFile(filePath, encoding),
      access: (filePath) => access(filePath),
    };
    this.now = options.now ?? (() => performance.now());
    this.procSelfCgroupPath = options.procSelfCgroupPath ?? '/proc/self/cgroup';
    this.procSelfMountinfoPath =
      options.procSelfMountinfoPath ?? '/proc/self/mountinfo';
    this.sysFsCgroupPath = options.sysFsCgroupPath ?? '/sys/fs/cgroup';
  }

  public async probe(): Promise<CgroupReaderAvailability> {
    try {
      const rootPath = await this.resolveRootPath();
      return { available: true, rootPath };
    } catch (error: unknown) {
      return {
        available: false,
        reason:
          error instanceof Error ? error.message : 'cgroup v2 is unavailable',
      };
    }
  }

  public async readSnapshot(): Promise<CgroupSnapshot> {
    const rootPath = await this.resolveRootPath();
    const memoryCurrentBytes = await this.readRequiredCounter(
      path.join(rootPath, 'memory.current'),
      'memory.current',
    );
    const events = await this.readMemoryEvents(
      path.join(rootPath, 'memory.events'),
    );
    const memoryMaxBytes = await this.readOptionalCounter(
      path.join(rootPath, 'memory.max'),
    );
    const memoryPeakBytes = await this.readOptionalCounter(
      path.join(rootPath, 'memory.peak'),
    );
    const swapCurrentBytes = await this.readOptionalCounter(
      path.join(rootPath, 'memory.swap.current'),
    );
    const pidsCurrent = await this.readOptionalCounter(
      path.join(rootPath, 'pids.current'),
    );
    const cpu = await this.readCpuStat(path.join(rootPath, 'cpu.stat'));

    return {
      sampledAtMonotonicMs: this.now(),
      memoryCurrentBytes,
      ...(memoryMaxBytes === undefined ? {} : { memoryMaxBytes }),
      ...(memoryPeakBytes === undefined ? {} : { memoryPeakBytes }),
      ...(swapCurrentBytes === undefined ? {} : { swapCurrentBytes }),
      ...(pidsCurrent === undefined ? {} : { pidsCurrent }),
      events,
      ...(cpu === undefined ? {} : { cpu }),
    };
  }

  private async resolveRootPath(): Promise<string> {
    this.rootPathPromise ??= this.discoverRootPath();
    try {
      return await this.rootPathPromise;
    } catch (error: unknown) {
      this.rootPathPromise = undefined;
      throw error;
    }
  }

  private async discoverRootPath(): Promise<string> {
    const directMemoryCurrent = path.join(
      this.sysFsCgroupPath,
      'memory.current',
    );
    if (await this.exists(directMemoryCurrent)) {
      return this.sysFsCgroupPath;
    }

    const relativePath = await this.readCgroupRelativePath();
    const mountRoot = await this.readCgroup2MountRoot();
    const candidate = path.posix.join(mountRoot, relativePath.replace(/^\//u, ''));
    const candidateMemoryCurrent = path.join(candidate, 'memory.current');
    if (!(await this.exists(candidateMemoryCurrent))) {
      throw new CgroupV2UnavailableError(
        `cgroup v2 memory.current not found at ${candidateMemoryCurrent}`,
      );
    }
    return candidate;
  }

  private async readCgroupRelativePath(): Promise<string> {
    let source: string;
    try {
      source = await this.fs.readFile(this.procSelfCgroupPath, 'utf8');
    } catch (error: unknown) {
      throw new CgroupV2UnavailableError(
        `unable to read ${this.procSelfCgroupPath}`,
        { cause: error },
      );
    }

    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      // cgroup v2: 0::/relative/path
      const match = /^0::(.*)$/u.exec(trimmed);
      if (match !== null) {
        const captured = match[1] ?? '';
        const relative = captured === '' ? '/' : captured;
        return relative.startsWith('/') ? relative : `/${relative}`;
      }
    }

    throw new CgroupV2UnavailableError(
      'no cgroup v2 hierarchy entry in /proc/self/cgroup',
    );
  }

  private async readCgroup2MountRoot(): Promise<string> {
    let source: string;
    try {
      source = await this.fs.readFile(this.procSelfMountinfoPath, 'utf8');
    } catch (error: unknown) {
      throw new CgroupV2UnavailableError(
        `unable to read ${this.procSelfMountinfoPath}`,
        { cause: error },
      );
    }

    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      // mountinfo: ... mountPoint filesystemType ...
      const separator = trimmed.indexOf(' - ');
      if (separator < 0) {
        continue;
      }
      const left = trimmed.slice(0, separator).split(' ');
      const right = trimmed.slice(separator + 3).split(' ');
      if (right[0] !== 'cgroup2') {
        continue;
      }
      const mountPoint = left[4];
      if (mountPoint !== undefined && mountPoint !== '') {
        return mountPoint;
      }
    }

    throw new CgroupV2UnavailableError('no cgroup2 mount in mountinfo');
  }

  private async readMemoryEvents(filePath: string): Promise<CgroupMemoryEvents> {
    const source = await this.readOptionalText(filePath);
    if (source === undefined) {
      return DEFAULT_EVENTS;
    }

    let high = 0n;
    let max = 0n;
    let oom = 0n;
    let oomKill = 0n;

    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      const [key, rawValue] = trimmed.split(/\s+/u);
      if (key === undefined || rawValue === undefined) {
        continue;
      }
      let value: bigint;
      try {
        value = parseNonNegativeBigInt(rawValue, `memory.events.${key}`);
      } catch {
        continue;
      }
      switch (key) {
        case 'high':
          high = value;
          break;
        case 'max':
          max = value;
          break;
        case 'oom':
          oom = value;
          break;
        case 'oom_kill':
          oomKill = value;
          break;
        default:
          break;
      }
    }

    return { high, max, oom, oomKill };
  }

  private async readCpuStat(filePath: string): Promise<CgroupCpuStat | undefined> {
    const source = await this.readOptionalText(filePath);
    if (source === undefined) {
      return undefined;
    }

    const counters = new Map<string, bigint>();
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      const [key, rawValue] = trimmed.split(/\s+/u);
      if (key === undefined || rawValue === undefined) {
        continue;
      }
      try {
        counters.set(
          key,
          parseNonNegativeBigInt(rawValue, `cpu.stat.${key}`),
        );
      } catch {
        // 忽略損壞的可選 CPU counter，避免中斷記憶體防護。
      }
    }

    const usageUsec = counters.get('usage_usec');
    if (usageUsec === undefined) {
      return undefined;
    }
    const userUsec = counters.get('user_usec');
    const systemUsec = counters.get('system_usec');
    return {
      usageUsec,
      ...(userUsec === undefined ? {} : { userUsec }),
      ...(systemUsec === undefined ? {} : { systemUsec }),
    };
  }

  private async readRequiredCounter(
    filePath: string,
    label: string,
  ): Promise<bigint> {
    try {
      const source = (await this.fs.readFile(filePath, 'utf8')).trim();
      return parseNonNegativeBigInt(source, label);
    } catch (error: unknown) {
      if (error instanceof CgroupV2ReadError) {
        throw error;
      }
      throw new CgroupV2ReadError(`failed to read ${label}`, { cause: error });
    }
  }

  private async readOptionalCounter(
    filePath: string,
  ): Promise<bigint | undefined> {
    const source = await this.readOptionalText(filePath);
    if (source === undefined) {
      return undefined;
    }
    const trimmed = source.trim();
    if (trimmed === '' || trimmed === 'max') {
      // memory.max may be "max" when unlimited — treat as unavailable.
      return undefined;
    }
    try {
      return parseNonNegativeBigInt(trimmed, path.basename(filePath));
    } catch {
      return undefined;
    }
  }

  private async readOptionalText(filePath: string): Promise<string | undefined> {
    try {
      return await this.fs.readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await this.fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

function parseNonNegativeBigInt(source: string, label: string): bigint {
  if (!/^\d+$/u.test(source)) {
    throw new CgroupV2ReadError(`${label} is not a non-negative integer`);
  }
  const value = BigInt(source);
  if (value < 0n) {
    throw new CgroupV2ReadError(`${label} must not be negative`);
  }
  return value;
}
