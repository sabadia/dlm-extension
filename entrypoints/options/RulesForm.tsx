import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { sendMessage } from '../../src/lib/bus/bus';
import { t } from '../../src/lib/i18n';
import type { DomainRoute, Settings } from '../../src/lib/settings/schema';

/** The interception rules and the badge and notification switches. */
export function RulesForm() {
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [note, setNote] = useState('');

  useEffect(() => {
    void sendMessage(browser.runtime, 'settings.get').then(setSettings, () => undefined);
  }, []);

  if (!settings) return null;
  const rules = settings.rules;
  const setRules = (patch: Partial<typeof rules>) =>
    setSettings({ ...settings, rules: { ...rules, ...patch } });

  return (
    <section aria-labelledby="rules-title">
      <h2 id="rules-title">{t('options.rules')}</h2>
      <label>
        <span>
          <input
            type="checkbox"
            checked={rules.intercept}
            onChange={(event) => setRules({ intercept: event.currentTarget.checked })}
          />{' '}
          {t('options.intercept')}
        </span>
      </label>
      <label>
        {t('options.minSize')}
        <input
          inputMode="numeric"
          value={String(rules.minSizeBytes)}
          onInput={(event) => setRules({ minSizeBytes: Number(event.currentTarget.value) })}
        />
      </label>
      <label>
        {t('options.excluded')}
        <textarea
          value={rules.excludedSites.join('\n')}
          onInput={(event) => setRules({ excludedSites: lines(event.currentTarget.value) })}
        />
        <span>{t('options.sitesHint')}</span>
      </label>
      <label>
        {t('options.always')}
        <textarea
          value={rules.alwaysSites.join('\n')}
          onInput={(event) => setRules({ alwaysSites: lines(event.currentTarget.value) })}
        />
      </label>
      <label>
        {t('options.fileTypes')}
        <input
          value={rules.fileTypes.join(', ')}
          onInput={(event) =>
            setRules({ fileTypes: lines(event.currentTarget.value.replace(/,/g, '\n')) })
          }
        />
      </label>
      <label>
        {t('options.mimeTypes')}
        <input
          value={rules.mimeTypes.join(', ')}
          onInput={(event) =>
            setRules({ mimeTypes: lines(event.currentTarget.value.replace(/,/g, '\n')) })
          }
        />
      </label>
      <label>
        {t('options.bypass')}
        <select
          value={rules.bypassKey}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === 'alt' || value === 'shift' || value === 'none')
              setRules({ bypassKey: value });
          }}
        >
          <option value="alt">{t('options.bypass.alt')}</option>
          <option value="shift">{t('options.bypass.shift')}</option>
          <option value="none">{t('options.bypass.none')}</option>
        </select>
      </label>
      <label>
        <span>
          <input
            type="checkbox"
            checked={rules.askFirst}
            onChange={(event) => setRules({ askFirst: event.currentTarget.checked })}
          />{' '}
          {t('options.askFirst')}
        </span>
      </label>
      <label>
        <span>
          <input
            type="checkbox"
            checked={rules.privateWindows}
            onChange={(event) => setRules({ privateWindows: event.currentTarget.checked })}
          />{' '}
          {t('options.private')}
        </span>
      </label>
      <label>
        <span>
          <input
            type="checkbox"
            checked={settings.preferences.badge}
            onChange={(event) =>
              setSettings({
                ...settings,
                preferences: { ...settings.preferences, badge: event.currentTarget.checked },
              })
            }
          />{' '}
          {t('options.badge')}
        </span>
      </label>
      <label>
        <span>
          <input
            type="checkbox"
            checked={settings.preferences.notifications}
            onChange={(event) =>
              setSettings({
                ...settings,
                preferences: {
                  ...settings.preferences,
                  notifications: event.currentTarget.checked,
                },
              })
            }
          />{' '}
          {t('options.notifications')}
        </span>
      </label>
      <label>
        <span>
          <input
            type="checkbox"
            checked={settings.preferences.mirrors}
            onChange={(event) =>
              setSettings({
                ...settings,
                preferences: { ...settings.preferences, mirrors: event.currentTarget.checked },
              })
            }
          />{' '}
          {t('options.mirrors')}
        </span>
      </label>
      <label>
        {t('options.routes')}
        <textarea
          value={settings.routes.map((route) => `${route.site} ${route.targetId}`).join('\n')}
          onInput={(event) =>
            setSettings({ ...settings, routes: routeLines(event.currentTarget.value) })
          }
        />
        <span>
          {t('options.routesHint')}{' '}
          {settings.targets
            .map(
              (target) =>
                `${target.kind === 'local' ? t('remote.local') : target.name} ${target.id}`,
            )
            .join(', ')}
        </span>
      </label>
      <button
        type="button"
        onClick={() => {
          void sendMessage(browser.runtime, 'settings.save', {
            rules: settings.rules,
            preferences: settings.preferences,
            routes: settings.routes,
          }).then(
            (saved) => {
              setSettings(saved);
              setNote(t('options.saved'));
            },
            () => undefined,
          );
        }}
      >
        {t('options.save')}
      </button>
      <p role="status">{note}</p>
      <SettingsFile />
    </section>
  );
}

function routeLines(value: string): DomainRoute[] {
  const routes: DomainRoute[] = [];
  for (const line of value.split('\n')) {
    const [site, targetId] = line.trim().split(/\s+/);
    if (!site || !targetId) continue;
    routes.push({ site, targetId });
  }
  return routes;
}

function importErrorText(error: unknown): string {
  return error instanceof Error ? error.message : t('error.failed');
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function SettingsFile() {
  const [note, setNote] = useState('');
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void sendMessage(browser.runtime, 'settings.export').then(
            async (text) => {
              await navigator.clipboard.writeText(text);
              setNote(t('options.diagnostics.copied'));
            },
            () => undefined,
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
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            void file.text().then((text) =>
              sendMessage(browser.runtime, 'settings.import', { text }).then(
                () => setNote(t('options.imported')),
                (error: unknown) => setNote(importErrorText(error)),
              ),
            );
          }}
        />
      </label>
      <p>{t('options.importHelp')}</p>
      <p role="status">{note}</p>
    </div>
  );
}
