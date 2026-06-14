import { describe, expect, it } from 'vitest';

import {
  selectActiveChannels,
  type ChannelLiveStatus,
} from '../../src/scheduler/StreamSelector.js';

const CHECKED_AT = '2026-06-14T12:00:00.000Z';

function status(
  channel: string,
  isLive: boolean,
): ChannelLiveStatus {
  return {
    channel,
    isLive,
    checkedAt: CHECKED_AT,
  };
}

describe('selectActiveChannels', () => {
  it('無人開台時回傳空陣列', () => {
    expect(
      selectActiveChannels({
        configuredChannels: ['first', 'second'],
        liveStatuses: [
          status('first', false),
          status('second', false),
        ],
        maxConcurrentStreams: 2,
      }),
    ).toEqual([]);
  });

  it('live 數量少於上限時回傳所有 live 頻道', () => {
    expect(
      selectActiveChannels({
        configuredChannels: ['first', 'second', 'third'],
        liveStatuses: [
          status('first', true),
          status('second', false),
          status('third', true),
        ],
        maxConcurrentStreams: 3,
      }),
    ).toEqual(['first', 'third']);
  });

  it('live 數量等於上限時回傳所有 live 頻道', () => {
    expect(
      selectActiveChannels({
        configuredChannels: ['first', 'second', 'third'],
        liveStatuses: [
          status('first', true),
          status('second', false),
          status('third', true),
        ],
        maxConcurrentStreams: 2,
      }),
    ).toEqual(['first', 'third']);
  });

  it('live 數量超過上限時依設定順序截斷', () => {
    expect(
      selectActiveChannels({
        configuredChannels: ['first', 'second', 'third'],
        liveStatuses: [
          status('first', true),
          status('second', true),
          status('third', true),
        ],
        maxConcurrentStreams: 2,
      }),
    ).toEqual(['first', 'second']);
  });

  it('API 回傳順序不同時仍依設定順序選台', () => {
    expect(
      selectActiveChannels({
        configuredChannels: ['first', 'second', 'third'],
        liveStatuses: [
          status('third', true),
          status('first', true),
          status('second', true),
        ],
        maxConcurrentStreams: 2,
      }),
    ).toEqual(['first', 'second']);
  });

  it('忽略未設定頻道的 live status', () => {
    expect(
      selectActiveChannels({
        configuredChannels: ['first', 'second'],
        liveStatuses: [
          status('unknown', true),
          status('second', true),
        ],
        maxConcurrentStreams: 2,
      }),
    ).toEqual(['second']);
  });

  it('缺少 status 的設定頻道視為 offline', () => {
    expect(
      selectActiveChannels({
        configuredChannels: ['missing', 'live'],
        liveStatuses: [status('live', true)],
        maxConcurrentStreams: 2,
      }),
    ).toEqual(['live']);
  });

  it('重複設定頻道以大小寫不敏感方式去重並保留第一次拼法', () => {
    expect(
      selectActiveChannels({
        configuredChannels: ['First', 'first', 'second', 'second'],
        liveStatuses: [
          status('FIRST', true),
          status('second', true),
        ],
        maxConcurrentStreams: 3,
      }),
    ).toEqual(['First', 'second']);
  });

  it('重複且大小寫不同的 status 一致為 live 時可選取一次', () => {
    expect(
      selectActiveChannels({
        configuredChannels: ['First'],
        liveStatuses: [
          status('first', true),
          status('FIRST', true),
        ],
        maxConcurrentStreams: 1,
      }),
    ).toEqual(['First']);
  });

  it('重複 status 衝突時採 offline 優先的保守行為', () => {
    expect(
      selectActiveChannels({
        configuredChannels: ['first', 'second'],
        liveStatuses: [
          status('FIRST', true),
          status('first', false),
          status('second', true),
        ],
        maxConcurrentStreams: 2,
      }),
    ).toEqual(['second']);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'maxConcurrentStreams=%s 不是正整數時回傳空陣列',
    (maxConcurrentStreams) => {
      expect(
        selectActiveChannels({
          configuredChannels: ['first'],
          liveStatuses: [status('first', true)],
          maxConcurrentStreams,
        }),
      ).toEqual([]);
    },
  );

  it('不改變 configuredChannels 或 liveStatuses 輸入', () => {
    const configuredChannels = Object.freeze(['second', 'first']);
    const liveStatuses = Object.freeze([
      Object.freeze(status('first', true)),
      Object.freeze(status('second', true)),
    ]);
    const configuredSnapshot = [...configuredChannels];
    const statusesSnapshot = liveStatuses.map((item) => ({ ...item }));

    const selectedChannels = selectActiveChannels({
      configuredChannels,
      liveStatuses,
      maxConcurrentStreams: 1,
    });
    selectedChannels.push('caller-owned-change');

    expect(configuredChannels).toEqual(configuredSnapshot);
    expect(liveStatuses).toEqual(statusesSnapshot);
  });
});
