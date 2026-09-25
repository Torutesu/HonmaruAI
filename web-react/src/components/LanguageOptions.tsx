import { readerLanguageOptions } from '../utils/locale'
import { useT } from '../utils/i18n'

/// The options of a "language you read" picker: the languages the screens
/// are translated into, then every other language cards and notifications
/// can be written in.
export function LanguageOptions({ current }: { current?: string }) {
  const t = useT()
  const options = readerLanguageOptions(current)
  return (
    <>
      <optgroup label={t('Screens, cards and notifications')}>
        {options.filter((o) => o.screens).map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
      </optgroup>
      <optgroup label={t('Cards and notifications (screens in English)')}>
        {options.filter((o) => !o.screens).map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
      </optgroup>
    </>
  )
}
