import './SoundChoice.css'
import React, { useState } from 'react'
import { useT } from '../utils/i18n'
import { DEFAULT_SOUNDS, loadSoundSettings, saveSoundSettings, playSound, type SoundSettings } from '../utils/sound'

export function SoundChoice({ value, onChange }: { value?: SoundSettings; onChange?: (s: SoundSettings) => void }) {
  const t = useT()
  const [previewError, setPreviewError] = useState(false)
  const [saved, setSaved] = useState(loadSoundSettings)
  const s = value || saved
  const important = s.enabled && s.mentions && s.decisions && s.replies && s.calls && !s.channels && !s.inConversation && !s.sent && !s.jam
  const choose = (next: SoundSettings) => { saveSoundSettings(next); setSaved(next); onChange?.(next) }
  return <section className="sound-choice" aria-label={t('Notification sounds')}>
    <h2>{t('Notification sounds')}</h2>
    <p>{t('Keep everyday messages quiet. Hear a short sound for a request, a reply, a mention or a call.')}</p>
    <div className="quiet-choices">
      <button type="button" className="pill-btn" aria-pressed={important} onClick={() => choose({ ...DEFAULT_SOUNDS, volume: s.volume || DEFAULT_SOUNDS.volume })}>{important && <span aria-hidden="true">✓ </span>}{t('Important only (recommended)')}</button>
      <button type="button" className="pill-btn" aria-pressed={!s.enabled} onClick={() => choose({ ...s, enabled: false })}>{!s.enabled && <span aria-hidden="true">✓ </span>}{t('No sounds')}</button>
    </div>
    {s.enabled && !important && <p className="hint">{t('Your custom sound settings are kept.')}</p>}
    <div className="quiet-choices" aria-label={t('Preview sounds')}>
      {([['decision', 'Preview request'], ['reply', 'Preview reply'], ['mention', 'Preview mention']] as const).map(([kind, label]) =>
        <button key={kind} type="button" className="pill-btn" onClick={() => setPreviewError(!playSound(kind, { preview: true }))}>{t(label)}</button>)}
    </div>
    {previewError && <p role="alert">{t('Sound could not play. Check your browser and audio output settings.')}</p>}
    <p className="hint">{t('Previews play only when pressed, even with sounds off. You can adjust each sound in notification settings.')}</p>
    <p className="hint">{t('On Mac, background notifications use the system sound and volume and follow Focus settings. The app volume controls sounds while you use Honmaru.')}</p>
  </section>
}
