// Settings card for the companion (spontaneous reach-out) rhythm. It edits the
// same config.json block as `/companion`, so the two surfaces never disagree.
// Styling reuses the shared bot-settings classes (dim-botGeneralRow and friends)
// exactly as the group-history and bot-general cards do; no card-local CSS.
import * as React from 'react';
import { h } from './i18n.js';

export const COMPANION_SETTINGS_ENDPOINTS = Object.freeze({
  get: 'settings.companion.get', set: 'settings.companion.set',
});

function result(value) {
  if (value?.ok === false) throw new Error(value.error?.message || '无法读取或保存主动联系设置，请稍后重试。');
  return value?.ok === true ? value.value : value;
}

/** One settings line: label + help on the left, the control on the right. */
function Row({ id, title, help, children }) {
  return h('div', { className: 'dim-botGeneralRow' },
    h('div', { className: 'dim-botGeneralText' },
      h('label', { className: 'dim-botGeneralTitle', htmlFor: id }, title),
      help ? h('p', { className: 'dim-botGeneralHelp', id: `${id}-help` }, help) : null),
    h('div', { className: 'dim-botGeneralControl' }, children));
}

function Switch({ id, label, help, checked, onChange, disabled }) {
  return h(Row, { id, title: label, help },
    h('input', {
      id, type: 'checkbox', role: 'switch', className: 'dim-contextSwitch',
      checked, disabled, 'aria-label': label,
      'aria-describedby': help ? `${id}-help` : undefined,
      onChange: (event) => onChange(event.target.checked),
    }));
}

function NumberInput({ id, label, help, unit, value, onChange, disabled, min = 0, max = 1440 }) {
  return h(Row, { id, title: label, help },
    h('input', {
      id, type: 'number', inputMode: 'numeric', min, max, value, disabled,
      className: 'dim-groupHistoryInput', 'aria-label': label,
      'aria-describedby': help ? `${id}-help` : undefined,
      onChange: (event) => onChange(event.target.value),
    }),
    unit ? h('span', { className: 'dim-groupHistoryUnit' }, unit) : null);
}

function ClockInput({ id, label, help, value, onChange, disabled }) {
  return h(Row, { id, title: label, help },
    h('input', {
      id, type: 'time', value, disabled,
      className: 'dim-groupHistoryInput', 'aria-label': label,
      'aria-describedby': help ? `${id}-help` : undefined,
      onChange: (event) => onChange(event.target.value),
    }));
}

/** A section label spanning the card, matching the panel-help separator. */
function GroupHeading({ children }) {
  return h('p', { className: 'dim-botGeneralHelp dim-botGeneralPanelHelp' }, children);
}

export function CompanionSettings({ account, botId: botIdProp, rpcCall }) {
  // The channel card passes the account; tests and other callers may pass an id.
  const botId = botIdProp ?? account?.botId ?? null;
  const [form, setForm] = React.useState(null);
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const mounted = React.useRef(false);
  const busy = React.useRef(false);
  const id = React.useId();

  const load = React.useCallback(async (signal) => {
    if (!botId) return;
    setPhase('loading'); setError(null);
    try {
      const settings = result(await rpcCall(COMPANION_SETTINGS_ENDPOINTS.get, { botId }, signal));
      if (signal?.aborted || !mounted.current) return;
      setForm(settings); setPhase('ready');
    } catch (caught) {
      if (signal?.aborted || !mounted.current) return;
      setError(caught.message); setPhase('error');
    }
  }, [botId, rpcCall]);

  React.useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [load]);

  const patch = (key) => (value) => { setForm((current) => ({ ...current, [key]: value })); setNotice(null); };

  const save = async (event) => {
    event.preventDefault();
    if (busy.current || phase === 'saving' || !form) return;
    busy.current = true; setPhase('saving'); setError(null); setNotice(null);
    try {
      const settings = result(await rpcCall(COMPANION_SETTINGS_ENDPOINTS.set, { botId, ...form }));
      if (mounted.current) { setForm(settings); setNotice('已保存'); setPhase('ready'); }
    } catch (caught) {
      if (mounted.current) { setError(caught.message); setPhase('ready'); }
    } finally {
      busy.current = false;
    }
  };

  if (!botId) return null;
  if (phase === 'error' && !form) {
    return h('section', {
      className: 'dim-botGeneralSettings', 'aria-label': '主动联系', 'aria-busy': 'false',
    },
      h(GroupHeading, null, '主动联系'),
      h('p', { role: 'alert', className: 'dim-accessFeedback', 'data-tone': 'error' }, error));
  }
  if (!form) {
    return h('section', {
      className: 'dim-botGeneralSettings', 'aria-label': '主动联系', 'aria-busy': 'true',
    },
      h(GroupHeading, null, '主动联系'),
      h('p', { role: 'status', className: 'dim-botGeneralHelp' }, '正在读取设置…'));
  }

  const disabled = phase === 'saving';
  return h('section', {
    className: 'dim-botGeneralSettings',
    'aria-label': '主动联系',
    'aria-busy': phase === 'saving' ? 'true' : 'false',
  },
    h(GroupHeading, null, '主动联系'),
    h('form', { onSubmit: save },
      h(Switch, {
        id: `${id}-enabled`, label: '启用主动联系', help: '关闭后完全不会主动发消息。',
        checked: form.enabled === true, disabled, onChange: patch('enabled'),
      }),
      h('p', { className: 'dim-botGeneralHelp' },
        '开启后她会自己挑时机找你说话，没什么可说的时候就不打扰。夜间会明显变少，但不会完全没有。'),

      form.enabled ? [
        h('p', { key: 'night-heading', className: 'dim-botGeneralHelp dim-botGeneralPanelHelp' }, '夜间安排'),
        h(ClockInput, {
          key: 'night-start', id: `${id}-night-start`, label: '夜间开始',
          value: form.nightStart, disabled, onChange: patch('nightStart'),
        }),
        h(ClockInput, {
          key: 'night-end', id: `${id}-night-end`, label: '夜间结束',
          value: form.nightEnd, disabled, onChange: patch('nightEnd'),
        }),
        h(Switch, {
          key: 'deep-quiet', id: `${id}-deep-quiet`, label: '深夜完全静音',
          help: '该时段内一条都不会发；关闭则保留极小概率。',
          checked: form.deepQuiet === true, disabled, onChange: patch('deepQuiet'),
        }),
        form.deepQuiet ? h(ClockInput, {
          key: 'deep-start', id: `${id}-deep-start`, label: '静音开始',
          value: form.deepQuietStart, disabled, onChange: patch('deepQuietStart'),
        }) : null,
        form.deepQuiet ? h(ClockInput, {
          key: 'deep-end', id: `${id}-deep-end`, label: '静音结束',
          value: form.deepQuietEnd, disabled, onChange: patch('deepQuietEnd'),
        }) : null,

        h('p', { key: 'rate-heading', className: 'dim-botGeneralHelp dim-botGeneralPanelHelp' }, '频率'),
        h(NumberInput, {
          key: 'day-cap', id: `${id}-day-cap`, label: '白天上限', unit: '次/天',
          value: form.dayCap, disabled, onChange: patch('dayCap'), min: 0, max: 24,
        }),
        h(NumberInput, {
          key: 'night-cap', id: `${id}-night-cap`, label: '夜间上限', unit: '次/天',
          value: form.nightCap, disabled, onChange: patch('nightCap'), min: 0, max: 24,
        }),
        h(NumberInput, {
          key: 'day-min', id: `${id}-day-min`, label: '白天最短间隔', unit: '分钟',
          value: form.dayIntervalMinutes, disabled, onChange: patch('dayIntervalMinutes'), min: 1,
        }),
        h(NumberInput, {
          key: 'day-max', id: `${id}-day-max`, label: '白天最长间隔', unit: '分钟',
          value: form.dayIntervalMaxMinutes, disabled, onChange: patch('dayIntervalMaxMinutes'), min: 1,
        }),
        h(NumberInput, {
          key: 'night-min', id: `${id}-night-min`, label: '夜间最短间隔', unit: '分钟',
          value: form.nightIntervalMinutes, disabled, onChange: patch('nightIntervalMinutes'), min: 1,
        }),
        h(NumberInput, {
          key: 'night-max', id: `${id}-night-max`, label: '夜间最长间隔', unit: '分钟',
          value: form.nightIntervalMaxMinutes, disabled, onChange: patch('nightIntervalMaxMinutes'), min: 1,
        }),

        h('p', { key: 'human-heading', className: 'dim-botGeneralHelp dim-botGeneralPanelHelp' }, '更像真人'),
        h(Switch, {
          key: 'decay', id: `${id}-decay`, label: '被冷落时收敛',
          help: '你连续没回，她会变安静，而不是越刷越多。',
          checked: form.decay !== false, disabled, onChange: patch('decay'),
        }),
        h(Switch, {
          key: 'images', id: `${id}-images`, label: '允许带图',
          help: '合适的时候她会发张图给你。',
          checked: form.allowImages !== false, disabled, onChange: patch('allowImages'),
        }),
      ] : null,

      error ? h('p', { role: 'alert', className: 'dim-accessFeedback', 'data-tone': 'error' }, error) : null,
      notice ? h('p', { role: 'status', className: 'dim-botGeneralHelp' }, notice) : null,
      h('div', { className: 'dim-botGeneralActions' },
        h('button', {
          type: 'submit', className: 'dim-deliveryButton', 'data-kind': 'primary', disabled,
        }, phase === 'saving' ? '保存中…' : '保存'))),
    h('p', { className: 'dim-botGeneralHelp' }, '也可以在聊天里用 /companion 查看状态、临时开关。'));
}
