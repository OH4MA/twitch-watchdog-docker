import { describe, expect, it, vi } from 'vitest';

import {
  selectActiveChannels,
  type StreamSelector,
} from '../../src/scheduler/StreamSelector.js';
import { DefaultWatchdogScheduler } from '../../src/scheduler/WatchdogScheduler.js';
import { DefaultSessionManager } from '../../src/sessions/index.js';
import { TwitchApiClient } from '../../src/twitch/index.js';
import { RecordingChannelSessionFactory } from '../helpers/recording-session-factory.js';
import { createTestConfig } from '../helpers/test-config.js';
import {
  createFixedClock,
  createRecordingLogger,
} from '../helpers/test-logger.js';

const ACCESS_TOKEN = 'integration-token-must-remain-secret';

describe('Helix 到 session 協調整合', () => {
  it('建立部分 live sessions、替換低優先序頻道，暫時 API 失敗時保留', async () => {
    const config = createTestConfig({
      channels: ['high_priority', 'medium_priority', 'low_priority'],
      maxConcurrentStreams: 2,
      twitchApi: { accessToken: ACCESS_TOKEN },
    });
    const clock = createFixedClock();
    const recordingLogger = createRecordingLogger(clock);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        helixResponse([
          helixStream('low_priority', 'stream-low'),
          helixStream('medium_priority', 'stream-medium'),
        ]),
      )
      .mockResolvedValueOnce(
        helixResponse([
          helixStream('low_priority', 'stream-low'),
          helixStream('high_priority', 'stream-high'),
          helixStream('medium_priority', 'stream-medium'),
        ]),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const twitchApiClient = new TwitchApiClient({
      clientId: config.twitchApi.clientId,
      accessToken: config.twitchApi.accessToken,
      checkIntervalSeconds: config.checkIntervalSeconds,
      logger: recordingLogger.logger,
      fetch: fetchMock,
      now: clock.date,
    });
    const sessionFactory = new RecordingChannelSessionFactory();
    const sessionManager = new DefaultSessionManager(sessionFactory, {
      logger: recordingLogger.logger,
    });
    const streamSelector: StreamSelector = { selectActiveChannels };
    const scheduler = new DefaultWatchdogScheduler({
      config,
      liveStatusProvider: twitchApiClient,
      streamSelector,
      sessionManager,
      logger: recordingLogger.logger,
      now: clock.date,
    });

    await scheduler.runOnce();

    expect(sessionManager.getActiveChannels()).toEqual([
      'medium_priority',
      'low_priority',
    ]);
    expect(sessionFactory.events).toEqual([
      { type: 'created', channel: 'medium_priority', generation: 1 },
      { type: 'started', channel: 'medium_priority', generation: 1 },
      { type: 'created', channel: 'low_priority', generation: 1 },
      { type: 'started', channel: 'low_priority', generation: 1 },
    ]);

    await scheduler.runOnce();

    expect(sessionManager.getActiveChannels()).toEqual([
      'high_priority',
      'medium_priority',
    ]);
    expect(sessionFactory.events.slice(4)).toEqual([
      {
        type: 'stopped',
        channel: 'low_priority',
        generation: 1,
        reason: 'inactive',
      },
      { type: 'created', channel: 'high_priority', generation: 1 },
      { type: 'started', channel: 'high_priority', generation: 1 },
    ]);

    const eventsBeforeTemporaryFailure = [...sessionFactory.events];
    await scheduler.runOnce();

    expect(sessionManager.getActiveChannels()).toEqual([
      'high_priority',
      'medium_priority',
    ]);
    expect(sessionFactory.events).toEqual(eventsBeforeTemporaryFailure);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recordingLogger.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'twitch_api_temporary_error',
          reason: 'server',
          statusCode: 503,
        }),
      ]),
    );
    expect(recordingLogger.serialized()).not.toContain(ACCESS_TOKEN);

    const firstRequest = fetchMock.mock.calls[0];
    expect(firstRequest).toBeDefined();
    const firstRequestUrl = new URL(String(firstRequest?.[0]));
    expect(firstRequestUrl.searchParams.getAll('user_login')).toEqual([
      'high_priority',
      'medium_priority',
      'low_priority',
    ]);
  });
});

function helixResponse(data: readonly Record<string, unknown>[]): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function helixStream(
  channel: string,
  streamId: string,
): Record<string, unknown> {
  return {
    id: streamId,
    user_login: channel,
    title: `${channel} live`,
    started_at: '2026-06-14T11:00:00.000Z',
    viewer_count: 10,
  };
}
