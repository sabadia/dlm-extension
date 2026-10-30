import { useEffect, useState } from 'preact/hooks';
import { t } from '../../src/lib/i18n';
import {
  draftFrom,
  entries,
  settingsFrom,
  type FormDraft,
  type FormErrors,
  type FormField,
} from '../../src/lib/settings/form';
import type { Settings, SettingsPatch } from '../../src/lib/settings/schema';
import { normalizeFileType, normalizeMimeType, normalizeSite } from '../../src/lib/settings/parse';
import { Button, Card, ChipInput, IconButton, Segmented, Switch } from '../../src/ui/kit';
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

  const list = (
    field: FormField,
    label: string,
    hint: string | undefined,
    name: 'excludedSites' | 'alwaysSites' | 'fileTypes' | 'mimeTypes',
    normalize: (input: string) => string | undefined,
    separator: string,
  ) => (
    <div class="field">
      <span class="label" id={`${field}-label`}>
        {label}
      </span>
      <ChipInput
        values={entries(draft[name])}
        label={label}
        normalize={normalize}
        describedBy={`${field}-help ${field}-error`}
        onChange={(values) => edit({ [name]: values.join(separator) })}
        {...(errors[field] ? { error: errorText(field, errors[field]) } : {})}
      />
      {hint ? (
        <span class="help" id={`${field}-help`}>
          {hint}
        </span>
      ) : null}
    </div>
  );

  const toggle = (name: keyof FormDraft, label: string, help?: string) => (
    <div class="setting">
      <Switch checked={draft[name] as boolean} onChange={(checked) => edit({ [name]: checked })}>
        {label}
      </Switch>
      {help ? <p class="help">{help}</p> : null}
    </div>
  );

  const files = (change: Partial<FormDraft['files']>) =>
    edit({ files: { ...draft.files, ...change } });

  return (
    <>
      <Card id="files" title={t('options.files.title')} description={t('options.files.help')}>
        <div class="stack">
          <div class="field">
            <span class="label">{t('options.files.surface')}</span>
            <Segmented
              label={t('options.files.surface')}
              value={draft.files.surface}
              options={[
                { value: 'panel', label: t('options.files.surface.panel') },
                { value: 'popup', label: t('options.files.surface.popup') },
              ]}
              onChange={(surface) => files({ surface })}
            />
            <span class="help">{t('options.files.surfaceHelp')}</span>
          </div>
          <div class="field">
            <span class="label">{t('files.naming')}</span>
            <Segmented
              label={t('files.naming')}
              value={draft.files.naming}
              options={[
                { value: 'title', label: t('files.naming.title') },
                { value: 'url', label: t('files.naming.url') },
              ]}
              onChange={(naming) => files({ naming })}
            />
          </div>
          <label class="field">
            <span class="label">{t('files.sort')}</span>
            <select
              class="select"
              value={draft.files.sort}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (
                  value === 'size-desc' ||
                  value === 'size-asc' ||
                  value === 'name' ||
                  value === 'type'
                )
                  files({ sort: value });
              }}
            >
              <option value="size-desc">{t('files.sort.size-desc')}</option>
              <option value="size-asc">{t('files.sort.size-asc')}</option>
              <option value="name">{t('files.sort.name')}</option>
              <option value="type">{t('files.sort.type')}</option>
            </select>
          </label>
          <div class="setting">
            <Switch
              checked={draft.files.followRedirects}
              onChange={(followRedirects) => files({ followRedirects })}
            >
              {t('options.files.redirects')}
            </Switch>
            <p class="help">{t('options.files.redirectsHelp')}</p>
          </div>
        </div>
      </Card>

      <Card id="rules" title={t('options.rules')} description={t('options.rulesHelp')}>
        <div class="stack">
          {toggle('intercept', t('options.intercept'))}
          <label class="field">
            <span class="label">{t('options.minSize')}</span>
            <input
              class="input"
              inputMode="numeric"
              value={draft.minSize}
              aria-invalid={errors.minSize ? 'true' : 'false'}
              aria-describedby="minSize-error"
              onInput={(event) => edit({ minSize: event.currentTarget.value })}
            />
            <span class="error" id="minSize-error" role="alert">
              {errors.minSize ? t('options.minSizeError') : ''}
            </span>
          </label>
          {list(
            'excludedSites',
            t('options.excluded'),
            t('options.sitesHint'),
            'excludedSites',
            normalizeSite,
            '\n',
          )}
          {list(
            'alwaysSites',
            t('options.always'),
            t('options.sitesHint'),
            'alwaysSites',
            normalizeSite,
            '\n',
          )}
          {list(
            'fileTypes',
            t('options.fileTypes'),
            undefined,
            'fileTypes',
            normalizeFileType,
            ', ',
          )}
          {list(
            'mimeTypes',
            t('options.mimeTypes'),
            undefined,
            'mimeTypes',
            normalizeMimeType,
            ', ',
          )}
          <label class="field">
            <span class="label">{t('options.bypass')}</span>
            <select
              class="select"
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
        </div>
      </Card>

      <Card id="more" title={t('options.more')}>
        <div class="stack">
          {toggle('badge', t('options.badge'))}
          {toggle('notifications', t('options.notifications'))}
          {toggle('mirrors', t('options.mirrors'))}
          {toggle('refresh', t('options.refresh'))}
        </div>
      </Card>

      <Card id="routes" title={t('options.routes')} description={t('options.routesHint')}>
        <fieldset class="plain" aria-describedby="routes-error">
          <legend class="visually-hidden">{t('options.routes')}</legend>
          <div class="stack">
            {draft.routes.map((route, index) => (
              <div class="row route" key={index}>
                <input
                  class="input grow"
                  aria-label={t('options.routeSite')}
                  value={route.site}
                  onInput={(event) =>
                    edit({
                      routes: draft.routes.map((r, i) =>
                        i === index ? { ...r, site: event.currentTarget.value } : r,
                      ),
                    })
                  }
                />
                <select
                  class="select"
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
                </select>
                <IconButton
                  icon="x"
                  label={t('options.routeRemove', { site: route.site || t('options.routeSite') })}
                  onClick={() => edit({ routes: draft.routes.filter((_r, i) => i !== index) })}
                />
              </div>
            ))}
            <p class="error" id="routes-error" role="alert">
              {errors.routes ? errorText('routes', errors.routes) : ''}
            </p>
            <div>
              <Button
                icon="plus"
                onClick={() =>
                  edit({
                    routes: [...draft.routes, { site: '', targetId: targets[0]?.id ?? 'local' }],
                  })
                }
              >
                {t('options.routeAdd')}
              </Button>
            </div>
          </div>
        </fieldset>
      </Card>

      <div class="savebar">
        <p class="grow" role="status" aria-live="polite">
          {note}
        </p>
        <Button variant="primary" disabled={busy} onClick={save}>
          {t('options.save')}
        </Button>
      </div>

      <SettingsFile
        api={api}
        saveFile={saveFile}
        onImported={(settings) => {
          setLoaded({ ...loaded, settings });
          setDraft(draftFrom(settings));
          setErrors({});
        }}
      />
    </>
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
    <Card id="advanced" title={t('options.advanced')}>
      <div class="row wrap">
        <Button
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
        </Button>
        <label class="btn">
          {t('options.import')}
          <input
            class="visually-hidden"
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
      </div>
      <p class="help" id="import-help">
        {t('options.importHelp')}
      </p>
      <p role="status" aria-live="polite">
        {note}
      </p>
    </Card>
  );
}
