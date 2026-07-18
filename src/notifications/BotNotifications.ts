export interface BrowserRestartNotification {
  readonly mode: 'automatic' | 'manual';
}

export interface ContainerRestartNotification {
  readonly reason: string;
  readonly source: string;
  readonly channel?: string;
  readonly detailReason?: string;
}

export function formatContainerRestartMessage(
  event: ContainerRestartNotification,
): string {
  const reason =
    event.detailReason !== undefined && event.detailReason !== event.reason
      ? `${event.reason}（${event.detailReason}）`
      : event.reason;
  const lines = [
    '🚨 容器即將重啟',
    `原因：${reason}`,
    `來源：${event.source}`,
  ];
  if (event.channel !== undefined && event.channel.length > 0) {
    lines.push(`頻道：${event.channel}`);
  }
  return lines.join('\n');
}

export function formatBrowserRestartMessage(
  event: BrowserRestartNotification,
): string {
  const modeLabel = event.mode === 'automatic' ? '自動恢復' : '完整回收';
  return `♻️ Firefox 瀏覽器已重啟（${modeLabel}）`;
}

export function formatPageCrashMessage(channel: string): string {
  return `💥 ${channel} 觀看頁面崩潰`;
}
