// Settings card for the companion (spontaneous reach-out) rhythm. It edits the
// same config.json block as `/companion`, so the two surfaces never disagree.
import * as React from 'react';
import { h } from './i18n.js';

export const COMPANION_SETTINGS_ENDPOINTS = Object.freeze({
  get: 'settings.companion.get', set: 'settings.companion.set',
});

function result(value) {
  if (value?.ok === false) throw new Error(value.error?.message || '无法读取或保存主动联系设置，请稍后重试。');
  return value?.ok === true ? value.value : value;
}

function NumberField({ id, label, hint, value, onChange, min = 0, max = 1440, disabled }) {
  return h('label', { className: 'dim-botGeneralControl dim-companionNumber', htmlFor: id },
    h('span', null, label),
    h('input', {
      id, type: 'number', inputMode: 'numeric', min, max,
      value, disabled, onChange: (event) => onChange(event.target.value),
    }),
    hint ? h('small', null, hint) : null);
}

function ClockField({ id, label, value, onChange, disabled }) {
  return h('label', { className: 'dim-botGeneralControl dim-companionClock', htmlFor: id },
    h('span', null, label),
    h('input', {
      id, type: 'time', value, disabled,
      onChange: (event) => onChange(event.target.value),
    }));
}

function ToggleField({ id, label, hint, checked, onChange, disabled }) {
  return h('label', { className: 'dim-botGeneralToggle dim-companionToggle', htmlFor: id },
    h('input', {
      id, type: 'checkbox', checked, disabled,
      onChange: (event) => onChange(event.target.checked),
    }),
    h('span', null, label),
    hint ? h('small', null, hint) : null);
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

  const patch = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));

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
  if (phase === 'loading' && !form) {
    return h('section', { className: 'dim-botGeneralSettings dim-companionSettings', 'aria-busy': 'true' },
      h('h3', null, '主动联系'), h('p', null, '正在读取设置…'));
  }
  if (phase === 'error' && !form) {
    return h('section', { className: 'dim-botGeneralSettings dim-companionSettings' },
      h('h3', null, '主动联系'), h('p', { className: 'dim-error' }, error));
  }

  const disabled = phase === 'saving';
  return h('form', {
    className: 'dim-botGeneralSettings dim-companionSettings',
    'aria-label': '主动联系', 'aria-busy': phase === 'saving' ? 'true' : 'false',
    onSubmit: save,
  },
    h('h3', null, '主动联系'),
    h('p', { className: 'dim-hint' },
      '开启后她会自己挑时机找你说话，没什么可说的时候就不打扰。夜间会明显变少，但不会完全没有。'),
    h(ToggleField, {
      id: 'dim-companion-enabled', label: '启用主动联系',
      hint: '关闭后完全不会主动发消息。',
      checked: form.enabled === true, disabled, onChange: patch('enabled'),
    }),
    h('div', { className: 'dim-companionGroup' },
      h('h4', null, '夜间安排'),
      h('div', { className: 'dim-companionRow' },
        h(ClockField, { id: 'dim-companion-night-start', label: '夜间开始', value: form.nightStart, disabled, onChange: patch('nightStart') }),
        h(ClockField, { id: 'dim-companion-night-end', label: '夜间结束', value: form.nightEnd, disabled, onChange: patch('nightEnd') })),
      h(ToggleField, {
        id: 'dim-companion-deep-quiet', label: '深夜完全静音',
        hint: '该时段内一条都不会发；关闭则保留极小概率。',
        checked: form.deepQuiet === true, disabled, onChange: patch('deepQuiet'),
      }),
      form.deepQuiet ? h('div', { className: 'dim-companionRow' },
        h(ClockField, { id: 'dim-companion-deep-start', label: '静音开始', value: form.deepQuietStart, disabled, onChange: patch('deepQuietStart') }),
        h(ClockField, { id: 'dim-companion-deep-end', label: '静音结束', value: form.deepQuietEnd, disabled, onChange: patch('deepQuietEnd') })) : null),
    h('div', { className: 'dim-companionGroup' },
      h('h4', null, '频率'),
      h('div', { className: 'dim-companionRow' },
        h(NumberField, { id: 'dim-companion-day-cap', label: '白天上限', hint: '次/天', value: form.dayCap, disabled, max: 24, onChange: patch('dayCap') }),
        h(NumberField, { id: 'dim-companion-night-cap', label: '夜间上限', hint: '次/天', value: form.nightCap, disabled, max: 24, onChange: patch('nightCap') })),
      h('div', { className: 'dim-companionRow' },
        h(NumberField, { id: 'dim-companion-day-min', label: '白天最短间隔', hint: '分钟', value: form.dayIntervalMinutes, disabled, onChange: patch('dayIntervalMinutes') }),
        h(NumberField, { id: 'dim-companion-day-max', label: '白天最长间隔', hint: '分钟', value: form.dayIntervalMaxMinutes, disabled, onChange: patch('dayIntervalMaxMinutes') })),
      h('div', { className: 'dim-companionRow' },
        h(NumberField, { id: 'dim-companion-night-min', label: '夜间最短间隔', hint: '分钟', value: form.nightIntervalMinutes, disabled, onChange: patch('nightIntervalMinutes') }),
        h(NumberField, { id: 'dim-companion-night-max', label: '夜间最长间隔', hint: '分钟', value: form.nightIntervalMaxMinutes, disabled, onChange: patch('nightIntervalMaxMinutes') }))),
    h('div', { className: 'dim-companionGroup' },
      h('h4', null, '更像真人'),
      h(ToggleField, {
        id: 'dim-companion-decay', label: '被冷落时收敛',
        hint: '你连续没回，她会变安静，而不是越刷越多。',
        checked: form.decay !== false, disabled, onChange: patch('decay'),
      }),
      h(ToggleField, {
        id: 'dim-companion-images', label: '允许带图',
        hint: '合适的时候她会发张图给你。',
        checked: form.allowImages !== false, disabled, onChange: patch('allowImages'),
      })),
    error ? h('p', { className: 'dim-error' }, error) : null,
    notice ? h('p', { className: 'dim-notice' }, notice) : null,
    h('div', { className: 'ddt-actions dim-viewActions' },
      h('button', { type: 'submit', className: 'ddt-button', 'data-kind': 'primary', disabled },
        phase === 'saving' ? '正在保存…' : '保存')),
    h('p', { className: 'dim-hint' }, '也可以在聊天里用 /companion 查看状态、临时开关。'));
}
