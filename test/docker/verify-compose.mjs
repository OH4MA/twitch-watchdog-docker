import process from 'node:process';

const mode = process.argv[2] ?? 'service';
let source = '';
for await (const chunk of process.stdin) {
  source += chunk;
}
const model = JSON.parse(source);
const service = model.services?.['twitch-watchdog'];

assert(service !== undefined, '缺少 twitch-watchdog service');
assert(service.build?.context !== undefined, '缺少 build context');
assert(service.build?.target === 'production', 'build target 必須是 production');
assert(
  service.container_name ===
    (mode === 'smoke'
      ? process.env.SMOKE_CONTAINER_NAME
      : 'twitch-watchdog'),
  'container_name 不正確',
);
assert(service.init === true, '必須啟用 init');
assert(service.read_only === true, 'root filesystem 必須唯讀');
assert(
  service.security_opt?.includes('no-new-privileges:true'),
  '必須啟用 no-new-privileges',
);
assert(
  service.security_opt?.some((option) =>
    option.startsWith('seccomp=') &&
    option.endsWith('/seccomp_profile.json'),
  ),
  '必須套用瀏覽器 seccomp profile',
);
assert(
  service.environment?.CONFIG_PATH === '/app/config.yml',
  'CONFIG_PATH 不正確',
);
assert(
  Object.hasOwn(service.environment ?? {}, 'TWITCH_CLIENT_ID'),
  '缺少 TWITCH_CLIENT_ID environment',
);
assert(
  Object.hasOwn(service.environment ?? {}, 'TWITCH_ACCESS_TOKEN'),
  '缺少 TWITCH_ACCESS_TOKEN environment',
);
assert(
  Object.hasOwn(service.environment ?? {}, 'TWITCH_CLIENT_SECRET'),
  '缺少 TWITCH_CLIENT_SECRET environment',
);
assert(
  Object.hasOwn(service.environment ?? {}, 'TELEGRAM_ENABLED'),
  '缺少 TELEGRAM_ENABLED environment',
);
assert(
  Object.hasOwn(service.environment ?? {}, 'TELEGRAM_BOT_TOKEN'),
  '缺少 TELEGRAM_BOT_TOKEN environment',
);
assert(
  Object.hasOwn(service.environment ?? {}, 'TELEGRAM_ALLOWED_CHAT_IDS'),
  '缺少 TELEGRAM_ALLOWED_CHAT_IDS environment',
);
assert(
  service.shm_size === '1073741824' ||
    service.shm_size === 1_073_741_824,
  'shm_size 必須是 1 GiB',
);

const volumes = service.volumes ?? [];
assertWritableBind(volumes, '/app/config.yml');
assertReadOnlyBind(volumes, '/data/browser-state');

if (mode === 'smoke') {
  assert(service.network_mode === 'none', 'smoke 必須停用網路');
  assert(service.restart === 'no', 'smoke restart policy 必須停用');
} else {
  assert(
    service.restart === 'unless-stopped',
    '正式服務 restart policy 必須是 unless-stopped',
  );
}

function assertReadOnlyBind(volumes, target) {
  const volume = volumes.find((candidate) => candidate.target === target);
  assert(volume !== undefined, `缺少 ${target} volume`);
  assert(volume.type === 'bind', `${target} 必須是 bind mount`);
  assert(volume.read_only === true, `${target} 必須是唯讀掛載`);
}

function assertWritableBind(volumes, target) {
  const volume = volumes.find((candidate) => candidate.target === target);
  assert(volume !== undefined, `缺少 ${target} volume`);
  assert(volume.type === 'bind', `${target} 必須是 bind mount`);
  assert(volume.read_only !== true, `${target} 必須允許寫入`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
