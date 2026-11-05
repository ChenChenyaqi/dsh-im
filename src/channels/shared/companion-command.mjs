// `/companion` control surface for the spontaneous reach-out scheduler. Kept
// separate from the controller so parsing, formatting and validation can be
// tested without a timer, a Harness or a channel.

import { t } from './i18n.mjs';

const COMPANION_ARGUMENT = /^\/(?:companion|cp)(?=$|\s)([\s\S]*)$/i;

export const COMPANION_USAGE = [
  '/companion  查看主动联系状态',
  '/companion on|off  开启或关闭',
  '/companion now  立刻触发一次',
  '/companion quiet 23:00-08:00  设置夜间区间',
  '/companion rate 5/2  每日上限（白天/夜间）',
  '/companion deep on|off  深夜深静音开关',
  '/companion reset  重置热情值',
  '/companion every 45-150 / 180-420  间隔区间（分钟，白天/夜间）',
];

function minutesOfClock(text) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function formatClock(minutes) {
  const bounded = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(bounded / 60)).padStart(2, '0')}:${String(bounded % 60).padStart(2, '0')}`;
}

function formatMinutes(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

function formatRelative(now, at) {
  if (!Number.isFinite(at)) return t('未安排');
  const delta = at - now;
  if (delta <= 0) return t('即将');
  return formatMinutes(delta);
}

/** Human status block for `/companion` without arguments. */
export function formatCompanionStatus(status, now = Date.now()) {
  const { remaining, config } = status;
  const lines = [
    `${t('主动联系')}：${status.enabled ? t('已开启') : t('已关闭')}`,
    `${t('当前时段')}：${status.night ? t('夜间') : t('白天')}（${remaining.cap} 次上限，已用 ${remaining.used}，剩 ${remaining.remaining}）`,
    `${t('下次预计')}：${status.enabled ? formatRelative(now, status.nextWakeAt) : t('未安排')}`,
    `${t('热情值')}：${status.moodLabel}（${status.mood.warmth.toFixed(2)}）`,
    `${t('夜间区间')}：${config.nightStart}-${config.nightEnd}${config.deepQuiet ? t('，深夜深静音已开') : ''}`,
    `${t('间隔')}：${t('白天')} ${formatMinutes(config.dayIntervalMinMs)}–${formatMinutes(config.dayIntervalMaxMs)}，`
      + `${t('夜间')} ${formatMinutes(config.nightIntervalMinMs)}–${formatMinutes(config.nightIntervalMaxMs)}`,
  ];
  if (status.lastDeliveredAt) {
    const ago = Math.max(1, Math.round((now - status.lastDeliveredAt) / 60_000));
    lines.push(`${t('上次主动')}：${ago} ${t('分钟前')}`);
  }
  if (status.lastDecision && status.lastDecision.allowed === false) {
    lines.push(`${t('上次跳过原因')}：${status.lastDecision.reason}`);
  }
  if (!status.conversationKey) lines.push(t('当前聊天尚未绑定会话，主动联系不会触发。'));
  return lines.join('\n');
}

/**
 * Parse and apply one `/companion` command. Returns the reply text, or null
 * when the text is not a companion command at all.
 */
export async function runCompanionCommand(text, controller) {
  const match = COMPANION_ARGUMENT.exec(String(text ?? '').trim());
  if (!match) return null;
  if (!controller) return t('主动联系在当前渠道不可用。');
  const args = match[1].trim().split(/\s+/).filter(Boolean);
  const [action, ...rest] = args;

  if (!action) return formatCompanionStatus(controller.status());

  if (action === 'on' || action === 'off') {
    const config = controller.updateConfig({ enabled: action === 'on' });
    return config.enabled
      ? t('主动联系已开启。她会自己找时机说话，没话说就不打扰你。')
      : t('主动联系已关闭。');
  }

  if (action === 'now') {
    const result = await controller.triggerNow();
    const reasonText = {
      skipped: t('她这次没什么想说的，没打扰你。'),
      'daily-cap': t('今天的主动次数已用完。'),
      'deep-quiet': t('当前处于深夜深静音时段。'),
      'quiet-after-user': t('你刚说过话，她暂时不插话。'),
      disabled: t('主动联系已关闭，先用 /companion on 开启。'),
      'no-target': t('当前没有可用的会话绑定。'),
      'no-session': t('当前聊天还没有会话。'),
      'ask-failed': t('Harness 没有返回结果，这次没发出去。'),
      'deliver-failed': t('消息发送失败。'),
      busy: t('上一次主动联系还在进行中。'),
      'cooled-down': t('她最近几次主动都没得到回应，正安静着。'),
    }[result.reason];
    if (result.delivered) return t('已触发一次主动联系。');
    return `${t('没有发送')}：${reasonText ?? result.reason}`;
  }

  if (action === 'quiet') {
    const value = rest.join('');
    const [start, end] = value.split('-');
    if (minutesOfClock(start ?? '') === null || minutesOfClock(end ?? '') === null) {
      return `${t('用法')}：/companion quiet 23:00-08:00`;
    }
    controller.updateConfig({ nightStart: start, nightEnd: end });
    return `${t('夜间区间已设为')} ${start}-${end}。`;
  }

  if (action === 'deep') {
    const value = rest[0]?.toLowerCase();
    if (value !== 'on' && value !== 'off') {
      return `${t('用法')}：/companion deep on|off`;
    }
    controller.updateConfig({ deepQuiet: value === 'on' });
    return value === 'on'
      ? t('深夜深静音已开启，该时段完全不会打扰你。')
      : t('深夜深静音已关闭，深夜仍有极小概率联系你。');
  }

  if (action === 'rate') {
    const value = rest.join('');
    const match2 = /^(\d{1,2})\/(\d{1,2})$/u.exec(value);
    if (!match2) return `${t('用法')}：/companion rate 5/2 （白天/夜间每日上限）`;
    controller.updateConfig({ dayCap: Number(match2[1]), nightCap: Number(match2[2]) });
    return `${t('每日上限已设为')} ${t('白天')} ${match2[1]} / ${t('夜间')} ${match2[2]}。`;
  }

  if (action === 'every') {
    const value = rest.join('');
    const parsed = /^(\d{2,4})-(\d{2,4})(?:\s*\/\s*(\d{2,4})-(\d{2,4}))?$/u.exec(value);
    if (!parsed) return `${t('用法')}：/companion every 45-150 / 180-420（分钟）`;
    const patch = {
      dayIntervalMinMs: Number(parsed[1]) * 60_000,
      dayIntervalMaxMs: Number(parsed[2]) * 60_000,
    };
    if (parsed[3] && parsed[4]) {
      patch.nightIntervalMinMs = Number(parsed[3]) * 60_000;
      patch.nightIntervalMaxMs = Number(parsed[4]) * 60_000;
    }
    controller.updateConfig(patch);
    return t('间隔区间已更新。');
  }

  if (action === 'reset') {
    controller.resetMood?.();
    return t('热情值已重置。');
  }

  return [t('未知参数。'), ...COMPANION_USAGE.map((line) => t(line))].join('\n');
}

/** Re-exported so the channel can format clocks the same way. */
export { formatClock, minutesOfClock };
