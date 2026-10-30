import { useEffect, useState } from 'preact/hooks';
import { t } from '../../src/lib/i18n';
import {
  draftFrom,
  settingsFrom,
  type FormDraft,
  type FormErrors,
  type FormField,
} from '../../src/lib/settings/form';
import type { Settings, SettingsPatch } from '../../src/lib/settings/schema';
import { saveTextFile } from '../../src/ui/save-file';

/** What the form needs from the background. The options page passes the real one; a test passes a fake. */
export interface SettingsApi {
  load(): Promise<{ settings: Settings; targets: { id: string; name: string }[] }>;
  save(patch: SettingsPatch): Promise<Settings>;
  exportText(): Promise<string>;
  importText(text: string): Promise<Settings>;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : t('error.failed');

/** The interception rules, the routes and the switches. Text is parsed when the person saves, not as they type. */
export function RulesForm({
  api,
  saveFile = saveTextFile,
}: {
  api: SettingsApi;
  saveFile?: (name: string, text: string) => void;
}) {
  const [loaded, setLoaded] = useState<{
    settings: Settings;
    targets: { id: string; name: string }[];
  }>();
  const [draft, setDraft] = useState<FormDraft>();
  const [errors, setErrors] = useState<FormErrors>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.load().then(
      (result) => {
        setLoaded(result);
        setDraft(draftFrom(result.settings));
      },
      (error: unknown) => setNote(message(error)),
    );
  }, []);

  if (!loaded || !draft) return note ? <p role="alert">{note}</p> : null;
  const edit = (change: Partial<FormDraft>) => {
    setDraft({ ...draft, ...change });
    setNote('');
  };
  const targets = loaded.targets;

  const save = () => {
    const result = settingsFrom(
      draft,
      loaded.settings,
      targets.map((target) => target.id),
    );
    if (!result.ok) {
      setErrors(result.errors);
      setNote(t('options.fixErrors'));
      return;
    }
    setErrors({});
    setBusy(true);
    api
      .save(result.patch)
      .then(
        (saved) => {
          setLoaded({ ...loaded, settings: saved });
          setDraft(draftFrom(saved));
          setNote(t('options.saved'));
        },
        (error: unknown) => setNote(t('options.saveFailed', { message: message(error) })),
      )
      .finally(() => setBusy(false));
  };

  const text = (
    field: FormField,
    label: string,
    hint: string | undefined,
    value: string,
    rows: number,
    name: keyof FormDraft,
  ) => (
    <label>
      {label}
      <textarea
        rows={rows}
        value={value}
        aria-invalid={errors[field] ? 'true' : 'false'}
        aria-describedby={`${field}-help ${field}-error`}
        onInput={(event) => edit({ [name]: event.currentTarget.value })}
      />
      <span id={`${field}-help`}>{hint}</span>
      <span id={`${field}-error`} role="alert">
        {errors[field] ? errorText(field, errors[field]) : ''}
      </span>
    </label>
  );

  const toggle = (name: keyof FormDraft, label: string) => (
    <label>
      <input
        type="checkbox"
        checked={draft[name] as boolean}
        onChange={(event) => edit({ [name]: event.currentTarget.checked })}
      />{' '}
      {label}
    </label>
  );

  return (
    <section aria-labelledby="rules-title">
      <h2 id="rules-title">{t('options.rules')}</h2>
      {toggle('intercept', t('options.intercept'))}
      <label>
        {t('options.minSize')}
        <input
          inputMode="numeric"
          value={draft.minSize}
          aria-invalid={errors.minSize ? 'true' : 'false'}
          aria-describedby="minSize-error"
          onInput={(event) => edit({ minSize: event.currentTarget.value })}
        />
        <span id="minSize-error" role="alert">
          {errors.minSize ? t('options.minSizeError') : ''}
        </span>
      </label>
      {text(
        'excludedSites',
        t('options.excluded'),
        t('options.sitesHint'),
        draft.excludedSites,
        3,
        'excludedSites',
      )}
      {text(
        'alwaysSites',
        t('options.always'),
        t('options.sitesHint'),
        draft.alwaysSites,
        3,
        'alwaysSites',
      )}
      {text('fileTypes', t('options.fileTypes'), undefined, draft.fileTypes, 1, 'fileTypes')}
      {text('mimeTypes', t('options.mimeTypes'), undefined, draft.mimeTypes, 1, 'mimeTypes')}
      <label>
        {t('options.bypass')}
        <select
          value={draft.bypassKey}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === 'alt' || value === 'shift' || value === 'none')
              edit({ bypassKey: value });
          }}
        >
          <option value="alt">{t('options.bypass.alt')}</option>
          <option value="shift">{t('options.bypass.shift')}</option>
          <option value="none">{t('options.bypass.none')}</option>
        </select>
      </label>
      {toggle('askFirst', t('options.askFirst'))}
      {toggle('privateWindows', t('options.private'))}
      {toggle('badge', t('options.badge'))}
      {toggle('notifications', t('options.notifications'))}
      {toggle('mirrors', t('options.mirrors'))}
      {toggle('refresh', t('options.refresh'))}

      <fieldset aria-describedby="routes-help routes-error">
        <legend>{t('options.routes')}</legend>
        <p id="routes-help">{t('options.routesHint')}</p>
        {draft.routes.map((route, index) => (
          <p key={index}>
            <input
              aria-label={t('options.routeSite')}
              value={route.site}
              onInput={(event) =>
                edit({
                  routes: draft.routes.map((r, i) =>
                    i === index ? { ...r, site: event.currentTarget.value } : r,
                  ),
                })
              }
            />{' '}
            <select
              aria-label={t('options.routeTarget')}
              value={route.targetId}
              onChange={(event) =>
                edit({
                  routes: draft.routes.map((r, i) =>
                    i === index ? { ...r, targetId: event.currentTarget.value } : r,
                  ),
                })
              }
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>{' '}
            <button
              type="button"
              onClick={() => edit({ routes: draft.routes.filter((_r, i) => i !== index) })}
            >
              {t('options.routeRemove', { site: route.site || t('options.routeSite') })}
            </button>
          </p>
        ))}
        <p id="routes-error" role="alert">
          {errors.routes ? errorText('routes', errors.routes) : ''}
        </p>
        <button
          type="button"
          onClick={() =>
            edit({ routes: [...draft.routes, { site: '', targetId: targets[0]?.id ?? 'local' }] })
          }
        >
          {t('options.routeAdd')}
        </button>
      </fieldset>

      <p>
        <button type="button" disabled={busy} onClick={save}>
          {t('options.save')}
        </button>
      </p>
      <p role="status" aria-live="polite">
        {note}
      </p>
      <SettingsFile
        api={api}
        saveFile={saveFile}
        onImported={(settings) => {
          setLoaded({ ...loaded, settings });
          setDraft(draftFrom(settings));
          setErrors({});
        }}
      />
    </section>
  );
}

function errorText(field: FormField, items: readonly string[]): string {
  const list = items.join(', ');
  switch (field) {
    case 'minSize':
      return t('options.minSizeError');
    case 'excludedSites':
    case 'alwaysSites':
      return t('options.sitesError', { items: list });
    case 'fileTypes':
      return t('options.typesError', { items: list });
    case 'mimeTypes':
      return t('options.mimesError', { items: list });
    case 'routes':
      return t('options.routesError', { items: list });
  }
}

function SettingsFile({
  api,
  saveFile,
  onImported,
}: {
  api: SettingsApi;
  saveFile: (name: string, text: string) => void;
  onImported: (settings: Settings) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          api.exportText().then(
            (text) => {
              saveFile('dlm-settings.json', text);
              setNote(t('options.exported'));
            },
            (error: unknown) => setNote(message(error)),
          );
        }}
      >
        {t('options.export')}
      </button>{' '}
      <label>
        {t('options.import')}
        <input
          type="file"
          accept="application/json,.json"
          aria-describedby="import-help"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            file
              .text()
              .then((text) => api.importText(text))
              .then(
                (settings) => {
                  onImported(settings);
                  setNote(t('options.imported'));
                },
                (error: unknown) => setNote(message(error)),
              );
          }}
        />
      </label>
      <p id="import-help">{t('options.importHelp')}</p>
      <p role="status" aria-live="polite">
        {note}
      </p>
    </div>
  );
}
