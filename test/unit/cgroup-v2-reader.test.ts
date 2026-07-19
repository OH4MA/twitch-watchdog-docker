import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CgroupV2Reader } from '../../src/app/CgroupV2Reader.js';

const tempDirs: string[] = [];

afterEach(async () => {
  // Best-effort cleanup; tests do not depend on leftover fixtures.
  tempDirs.length = 0;
});

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'cgroup-v2-'));
  tempDirs.push(root);
  return root;
}

describe('CgroupV2Reader', () => {
  it('從 cgroup 根目錄讀取 cpu/memory/swap/pids/events', async () => {
    const root = await createFixtureRoot();
    await writeFile(path.join(root, 'memory.current'), '123456789\n');
    await writeFile(path.join(root, 'memory.max'), '6442450944\n');
    await writeFile(path.join(root, 'memory.peak'), '234567890\n');
    await writeFile(path.join(root, 'memory.swap.current'), '111\n');
    await writeFile(path.join(root, 'pids.current'), '42\n');
    await writeFile(
      path.join(root, 'cpu.stat'),
      'usage_usec 987654\nuser_usec 700000\nsystem_usec 287654\nnr_periods 12\n',
    );
    await writeFile(
      path.join(root, 'memory.events'),
      'low 0\nhigh 2\nmax 1\noom 3\noom_kill 4\nunknown 9\n',
    );

    const reader = new CgroupV2Reader({
      sysFsCgroupPath: root,
      now: () => 1_000,
    });

    const probe = await reader.probe();
    expect(probe).toEqual({ available: true, rootPath: root });

    const snapshot = await reader.readSnapshot();
    expect(snapshot).toEqual({
      sampledAtMonotonicMs: 1_000,
      memoryCurrentBytes: 123_456_789n,
      memoryMaxBytes: 6_442_450_944n,
      memoryPeakBytes: 234_567_890n,
      swapCurrentBytes: 111n,
      pidsCurrent: 42n,
      cpu: {
        usageUsec: 987_654n,
        userUsec: 700_000n,
        systemUsec: 287_654n,
      },
      events: {
        high: 2n,
        max: 1n,
        oom: 3n,
        oomKill: 4n,
      },
    });
  });

  it('cpu.stat 缺少或 usage_usec 格式錯誤時視為不可用', async () => {
    const root = await createFixtureRoot();
    await writeFile(path.join(root, 'memory.current'), '100\n');
    await writeFile(path.join(root, 'cpu.stat'), 'usage_usec invalid\nuser_usec 10\n');

    const snapshot = await new CgroupV2Reader({
      sysFsCgroupPath: root,
    }).readSnapshot();

    expect(snapshot.cpu).toBeUndefined();
  });

  it('memory.max 為 max 時視為不可用', async () => {
    const root = await createFixtureRoot();
    await writeFile(path.join(root, 'memory.current'), '100\n');
    await writeFile(path.join(root, 'memory.max'), 'max\n');
    await writeFile(path.join(root, 'memory.events'), 'high 0\nmax 0\noom 0\noom_kill 0\n');

    const snapshot = await new CgroupV2Reader({
      sysFsCgroupPath: root,
      now: () => 0,
    }).readSnapshot();

    expect(snapshot.memoryMaxBytes).toBeUndefined();
  });

  it('缺少 memory.current 時標記為不可用', async () => {
    const root = await createFixtureRoot();
    const probe = await new CgroupV2Reader({
      sysFsCgroupPath: root,
      procSelfCgroupPath: path.join(root, 'missing-cgroup'),
      procSelfMountinfoPath: path.join(root, 'missing-mountinfo'),
    }).probe();

    expect(probe.available).toBe(false);
  });

  it('可透過 mountinfo + /proc/self/cgroup 解析命名空間路徑', async () => {
    const root = await createFixtureRoot();
    const mountRoot = path.join(root, 'mount');
    const relative = '/docker/abc';
    const cgroupDir = path.join(mountRoot, 'docker/abc');
    await mkdir(cgroupDir, { recursive: true });
    await writeFile(path.join(cgroupDir, 'memory.current'), '50\n');
    await writeFile(
      path.join(cgroupDir, 'memory.events'),
      'high 0\nmax 0\noom 0\noom_kill 0\n',
    );

    const emptySys = path.join(root, 'sys-empty');
    await mkdir(emptySys);

    const procCgroup = path.join(root, 'cgroup');
    const procMountinfo = path.join(root, 'mountinfo');
    await writeFile(procCgroup, `0::${relative}\n`);
    await writeFile(
      procMountinfo,
      `1 0 0:0 / ${mountRoot} rw - cgroup2 cgroup2 rw\n`,
    );

    const reader = new CgroupV2Reader({
      sysFsCgroupPath: emptySys,
      procSelfCgroupPath: procCgroup,
      procSelfMountinfoPath: procMountinfo,
      now: () => 5,
    });

    await expect(reader.readSnapshot()).resolves.toMatchObject({
      memoryCurrentBytes: 50n,
      sampledAtMonotonicMs: 5,
    });
  });

  it('memory.current 格式錯誤時拋出讀取錯誤', async () => {
    const root = await createFixtureRoot();
    await writeFile(path.join(root, 'memory.current'), 'not-a-number\n');

    await expect(
      new CgroupV2Reader({ sysFsCgroupPath: root }).readSnapshot(),
    ).rejects.toBeInstanceOf(Error);
  });
});
