import { describe, expect, it } from 'vitest';

import {
  createRuntimeStartupDiagnostics,
  createSafeConfigFingerprint,
} from '../../src/app/RuntimeDiagnostics.js';
import { createTestConfig } from '../helpers/test-config.js';

describe('RuntimeDiagnostics', () => {
  it('產生完整、安全且可關聯的 startup diagnostics', () => {
    const config = createTestConfig();
    const diagnostics = createRuntimeStartupDiagnostics({
      config,
      browserManager: {
        getBrowserGeneration: () => 7,
        getBrowserVersion: () => '142.0.1',
      },
      resourceLimits: {
        getLatestResourceLimits: () => ({
          memoryMaxBytes: 6_442_450_944,
          pidsMax: '9007199254740992',
        }),
      },
      env: {
        APPLICATION_VERSION: '0.2.0-canary',
        GIT_COMMIT: 'ABCDEF1234567',
        PLAYWRIGHT_VERSION: '1.62.1',
      },
      browserEngine: 'firefox',
      runId: 'test-run-1234',
      nodeVersion: 'v24.7.0',
    });

    expect(diagnostics).toEqual({
      runId: 'test-run-1234',
      applicationVersion: '0.2.0-canary',
      gitCommit: 'abcdef1234567',
      nodeVersion: 'v24.7.0',
      playwrightVersion: '1.62.1',
      browserEngine: 'firefox',
      browserVersion: '142.0.1',
      browserGeneration: 7,
      memoryMaxBytes: 6_442_450_944,
      pidsMax: '9007199254740992',
      safeConfigFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it('fingerprint 排除 credentials、storage path 與 bot private IDs', () => {
    const first = createTestConfig({
      storageStatePath: '/secret/first-storage-state.json',
      twitchApi: {
        clientId: 'first-client',
        accessToken: 'first-access-token',
        clientSecret: 'first-client-secret',
      },
      telegram: {
        botToken: 'first-telegram-token',
        allowedChatIds: ['111111'],
      },
      discord: {
        botToken: 'first-discord-token',
        applicationId: 'first-application-id',
        guildId: 'first-guild-id',
        allowedChannelIds: ['first-channel-id'],
        allowedUserIds: ['first-user-id'],
      },
    });
    const second = createTestConfig({
      storageStatePath: '/secret/second-storage-state.json',
      twitchApi: {
        clientId: 'second-client',
        accessToken: 'second-access-token',
        clientSecret: 'second-client-secret',
      },
      telegram: {
        botToken: 'second-telegram-token',
        allowedChatIds: ['222222'],
      },
      discord: {
        botToken: 'second-discord-token',
        applicationId: 'second-application-id',
        guildId: 'second-guild-id',
        allowedChannelIds: ['second-channel-id'],
        allowedUserIds: ['second-user-id'],
      },
    });

    expect(createSafeConfigFingerprint(first)).toBe(
      createSafeConfigFingerprint(second),
    );
    expect(
      createSafeConfigFingerprint(createTestConfig({
        maxConcurrentStreams: 1,
      })),
    ).not.toBe(createSafeConfigFingerprint(first));
  });

  it('缺值或不安全版本欄位使用明確 null/unknown', () => {
    const config = createTestConfig();
    const first = createRuntimeStartupDiagnostics({
      config,
      browserManager: {
        getBrowserGeneration: () => 0,
        getBrowserVersion: () => null,
      },
      env: {
        APPLICATION_VERSION: 'token=secret',
        GIT_COMMIT: 'not-a-commit',
        PLAYWRIGHT_VERSION: 'Bearer secret',
      },
      browserEngine: 'webkit',
    });
    const second = createRuntimeStartupDiagnostics({
      config,
      browserManager: {
        getBrowserGeneration: () => 0,
        getBrowserVersion: () => null,
      },
      env: {},
    });

    expect(first).toMatchObject({
      applicationVersion: null,
      gitCommit: null,
      playwrightVersion: null,
      browserEngine: 'unknown',
      browserVersion: null,
      memoryMaxBytes: null,
      pidsMax: null,
    });
    expect(first.runId).toBe(second.runId);
  });
});
