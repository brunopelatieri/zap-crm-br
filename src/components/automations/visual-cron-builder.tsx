'use client';

import { useMemo, useState } from 'react';
import type { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DEFAULT_TIME_ZONE,
  resolveTimeZone,
  type Weekday,
} from '@/lib/broadcasts/send-window';
import {
  INTERVAL_HOUR_OPTIONS,
  INTERVAL_MINUTE_OPTIONS,
  type ScheduleMode,
  type ScheduleState,
  describeSchedule,
  parseSchedule,
  scheduleCoverage,
  scheduleToCron,
  validateSchedule,
} from '@/lib/automations/schedule';
import { cn } from '@/lib/utils';
import { SELECT_CLASS, TagSelect } from './automation-builder';

// Modos visíveis como pílulas; "avançado" é um link discreto (SPEC 046
// §5.2) — é escape, não uma quinta escolha de peso igual.
const VISIBLE_MODES: ScheduleMode[] = [
  'interval',
  'daily',
  'weekly',
  'monthly',
];
const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const PREVIEW_COUNT = 2;

/**
 * Substitui o campo de texto cru do gatilho "Baseado em horário" por
 * pílulas, um horário e um resumo em linguagem natural (SPEC 046).
 *
 * Fonte da verdade: a string cron em `config.schedule`. O `ScheduleState`
 * visual é derivado dela e vive só neste componente — nunca é gravado
 * no banco (§4.4), o que evita uma segunda fonte da verdade divergindo
 * assim que uma linha for escrita pelo modo avançado ou pela API.
 */
export function VisualCronBuilder({
  config,
  onChange,
  t,
}: {
  config: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const cronFromProps = (config.schedule as string) ?? '';
  const [state, setState] = useState<ScheduleState>(() =>
    parseSchedule(cronFromProps)
  );
  // Espelha `cronFromProps` só para detectar, DURANTE o render, quando
  // ele mudou desde a última passada — o padrão "ajustar estado quando
  // uma prop muda" dos docs do React, que evita o `useEffect` +
  // `setState` (efeito em cascata, sinalizado pelo lint).
  const [lastSeenProp, setLastSeenProp] = useState(cronFromProps);
  // Guarda contra laço (§4.4): só re-semeia a partir de `props.value`
  // quando o cron recebido é DIFERENTE do último que este componente
  // emitiu — senão parse→render→serialize→onChange→props fecha um laço
  // que reescreve a expressão do usuário a cada tecla. Em `useState`
  // (não `useRef`): o lint dos hooks trata leitura/escrita de ref
  // durante o render como não permitida.
  const [lastEmittedCron, setLastEmittedCron] = useState<string | null>(
    cronFromProps || null
  );

  if (cronFromProps !== lastSeenProp) {
    setLastSeenProp(cronFromProps);
    if (cronFromProps !== lastEmittedCron) {
      setState(parseSchedule(cronFromProps));
      setLastEmittedCron(cronFromProps || null);
    }
  }

  const timezone = resolveTimeZone(config.timezone) || DEFAULT_TIME_ZONE;

  /** `emit=false` só atualiza o estado local (ex.: semanal com zero
   *  dias marcados) — só cron VÁLIDO sobe para `trigger_config`. */
  function commit(next: ScheduleState, emit: boolean) {
    setState(next);
    if (!emit) return;
    const cron = scheduleToCron(next);
    setLastEmittedCron(cron);
    onChange({
      ...config,
      schedule: cron,
      // Capturado uma vez, na primeira mudança real — padrão já
      // validado em `broadcasts.scheduled_timezone` (SPEC 044 §6.3).
      timezone:
        (config.timezone as string) ||
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  function switchMode(mode: ScheduleMode) {
    if (mode === state.mode) return;
    const hour = 'hour' in state ? state.hour : 9;
    const minute = 'minute' in state ? state.minute : 0;
    if (mode === 'interval') {
      commit({ mode: 'interval', unit: 'minute', every: 15 }, true);
    } else if (mode === 'daily') {
      commit({ mode: 'daily', hour, minute }, true);
    } else if (mode === 'weekly') {
      commit({ mode: 'weekly', hour, minute, weekdays: [1, 2, 3, 4, 5] }, true);
    } else if (mode === 'monthly') {
      commit({ mode: 'monthly', hour, minute, monthDays: [1] }, true);
    } else {
      commit({ mode: 'advanced', raw: scheduleToCron(state) }, true);
    }
  }

  function updateTime(hour: number, minute: number) {
    if (
      state.mode !== 'daily' &&
      state.mode !== 'weekly' &&
      state.mode !== 'monthly'
    ) {
      return;
    }
    commit({ ...state, hour, minute }, true);
  }

  function toggleWeekday(day: Weekday) {
    if (state.mode !== 'weekly') return;
    const has = state.weekdays.includes(day);
    const weekdays = (
      has ? state.weekdays.filter((d) => d !== day) : [...state.weekdays, day]
    ).sort((a, b) => a - b);
    commit({ ...state, weekdays }, weekdays.length > 0);
  }

  function setWeekdayPreset(preset: 'weekdays' | 'all') {
    if (state.mode !== 'weekly') return;
    const weekdays: Weekday[] =
      preset === 'weekdays' ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6];
    commit({ ...state, weekdays }, true);
  }

  function setMonthDay(day: number) {
    if (state.mode !== 'monthly') return;
    commit({ ...state, monthDays: [day] }, true);
  }

  function chooseInterval(unit: 'minute' | 'hour', every: number) {
    commit({ mode: 'interval', unit, every }, true);
  }

  function setAdvancedRaw(raw: string) {
    // Só emite quando válido — enquanto o usuário digita um cron
    // incompleto, `trigger_config` mantém o último valor válido em vez
    // de gravar lixo.
    commit({ mode: 'advanced', raw }, validateSchedule(raw) === null);
  }

  const advancedError =
    state.mode === 'advanced' ? validateSchedule(state.raw) : null;
  // Semanal sem nenhum dia marcado não é um agendamento — é um estado
  // intermediário. `scheduleToCron` mapearia os dias vazios para `*`,
  // e a pré-visualização acabaria mostrando disparos DIÁRIOS enquanto o
  // aviso na tela diz que falta escolher um dia.
  const incomplete = state.mode === 'weekly' && state.weekdays.length === 0;
  const summary = describeSchedule(state, t);

  // `scheduleCoverage` varre até 366 dias no pior caso (um agendamento
  // que nunca dispara) — memoizado para não repetir isso a cada render
  // do construtor.
  const cron = scheduleToCron(state);
  const coverage = useMemo(
    () =>
      advancedError != null || incomplete
        ? null
        : scheduleCoverage(cron, timezone, PREVIEW_COUNT),
    [cron, timezone, advancedError, incomplete]
  );

  return (
    <div className="space-y-3">
      <div>
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          {t('scheduleBuilder.frequencyLabel')}
        </label>
        <div className="flex flex-wrap gap-1.5">
          {VISIBLE_MODES.map((mode) => (
            <Button
              key={mode}
              type="button"
              size="xs"
              variant={state.mode === mode ? 'default' : 'outline'}
              onClick={() => switchMode(mode)}
            >
              {t(`scheduleBuilder.modes.${mode}`)}
            </Button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => switchMode('advanced')}
          className={cn(
            'text-muted-foreground hover:text-foreground mt-1 text-[11px] underline-offset-2 hover:underline',
            state.mode === 'advanced' && 'text-primary font-medium'
          )}
        >
          {t('scheduleBuilder.advancedLink')}
        </button>
      </div>

      {state.mode === 'interval' && (
        <div>
          <label className="text-muted-foreground mb-1 block text-xs font-medium">
            {t('scheduleBuilder.intervalLabel')}
          </label>
          <select
            value={`${state.unit}:${state.every}`}
            onChange={(e) => {
              const [unit, every] = e.target.value.split(':');
              chooseInterval(unit as 'minute' | 'hour', Number(every));
            }}
            className={SELECT_CLASS}
          >
            <optgroup label={t('scheduleBuilder.intervalGroupMinutes')}>
              {INTERVAL_MINUTE_OPTIONS.map((every) => (
                <option key={every} value={`minute:${every}`}>
                  {t(`scheduleBuilder.intervalOptions.min${every}`)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('scheduleBuilder.intervalGroupHours')}>
              {INTERVAL_HOUR_OPTIONS.map((every) => (
                <option key={every} value={`hour:${every}`}>
                  {t(`scheduleBuilder.intervalOptions.hour${every}`)}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
      )}

      {(state.mode === 'daily' ||
        state.mode === 'weekly' ||
        state.mode === 'monthly') && (
        <div>
          <label className="text-muted-foreground mb-1 block text-xs font-medium">
            {t('scheduleBuilder.timeLabel')}
          </label>
          <Input
            type="time"
            value={`${String(state.hour).padStart(2, '0')}:${String(
              state.minute
            ).padStart(2, '0')}`}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':').map(Number);
              if (Number.isFinite(h) && Number.isFinite(m)) updateTime(h, m);
            }}
            className="bg-muted text-foreground"
          />
        </div>
      )}

      {state.mode === 'weekly' && (
        <div>
          <label className="text-muted-foreground mb-1 block text-xs font-medium">
            {t('scheduleBuilder.weekdaysLabel')}
          </label>
          <div className="flex gap-1">
            {WEEKDAYS.map((day) => (
              <button
                key={day}
                type="button"
                onClick={() => toggleWeekday(day)}
                aria-pressed={state.weekdays.includes(day)}
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium transition-colors',
                  state.weekdays.includes(day)
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-muted text-muted-foreground hover:text-foreground'
                )}
              >
                {t(`scheduleBuilder.weekdayShort.${day}`)}
              </button>
            ))}
          </div>
          {state.weekdays.length === 0 && (
            <p className="mt-1 text-[11px] text-amber-400">
              {t('scheduleBuilder.weekdaysEmptyWarn')}
            </p>
          )}
          <div className="mt-1.5 flex gap-3">
            <button
              type="button"
              onClick={() => setWeekdayPreset('weekdays')}
              className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
            >
              {t('scheduleBuilder.weekdayPresetWeekdays')}
            </button>
            <button
              type="button"
              onClick={() => setWeekdayPreset('all')}
              className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
            >
              {t('scheduleBuilder.weekdayPresetAll')}
            </button>
          </div>
        </div>
      )}

      {state.mode === 'monthly' && (
        <div>
          <label className="text-muted-foreground mb-1 block text-xs font-medium">
            {t('scheduleBuilder.monthDayLabel')}
          </label>
          <select
            value={state.monthDays[0] ?? 1}
            onChange={(e) => setMonthDay(Number(e.target.value))}
            className={SELECT_CLASS}
          >
            {MONTH_DAYS.map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </select>
          {(state.monthDays[0] ?? 1) >= 29 && (
            <p className="text-muted-foreground mt-1 text-[11px]">
              {t('scheduleBuilder.monthDayShortWarn')}
            </p>
          )}
        </div>
      )}

      {state.mode === 'advanced' && (
        <div>
          <label className="text-muted-foreground mb-1 block text-xs font-medium">
            {t('schedule')}
          </label>
          <Input
            placeholder={t('schedulePlaceholder')}
            value={state.raw}
            onChange={(e) => setAdvancedRaw(e.target.value)}
            className="bg-muted text-foreground font-mono"
          />
          <p className="text-muted-foreground mt-1 text-[11px]">
            {t('scheduleHint')}
          </p>
          {advancedError && (
            <p className="text-destructive mt-1 text-[11px]">
              {t('scheduleBuilder.advancedError', { message: advancedError })}
            </p>
          )}
        </div>
      )}

      <div className="border-border bg-muted/50 rounded-md border px-2.5 py-2">
        <p className="text-foreground text-xs font-medium">
          {advancedError
            ? t('scheduleBuilder.invalidSummary')
            : incomplete
              ? t('scheduleBuilder.incompleteSummary')
              : summary}
        </p>
        {coverage && (
          <p className="text-muted-foreground mt-0.5 text-[11px]">
            {coverage.deliverable.length > 0
              ? t('scheduleBuilder.nextOccurrences', {
                  list: coverage.deliverable
                    .map((d) => formatOccurrence(d, timezone))
                    .join(' · '),
                })
              : t('scheduleBuilder.noOccurrences')}
          </p>
        )}
        <p className="text-muted-foreground mt-0.5 text-[11px]">
          {t('scheduleBuilder.timezoneNote', { timezone })}
        </p>
        {/* A janela de horário permitido (dias úteis, 09h–20h) é
            invisível no construtor, mas é ela que decide se o
            agendamento roda. Sem estes dois avisos, "todo sábado às
            10h" salvava, ativava e nunca disparava — sem erro nenhum. */}
        {coverage?.neverFires && (
          <p className="text-destructive mt-1 text-[11px]">
            {t('scheduleBuilder.sendWindowNever')}
          </p>
        )}
        {coverage && !coverage.neverFires && coverage.someBlocked && (
          <p className="mt-1 text-[11px] text-amber-400">
            {t('scheduleBuilder.sendWindowPartial')}
          </p>
        )}
      </div>

      <div>
        <label className="text-muted-foreground mb-1 block text-xs font-medium">
          {t('scheduleBuilder.audienceLabel')}
        </label>
        <TagSelect
          value={(config.audience_tag_id as string) ?? ''}
          onChange={(v) => onChange({ ...config, audience_tag_id: v })}
          t={t}
        />
        <p className="text-muted-foreground mt-1 text-[11px]">
          {t('scheduleBuilder.audienceHint')}
        </p>
      </div>
    </div>
  );
}

function formatOccurrence(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
