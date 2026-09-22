// Small, offline release-regression gate. Runtime and device QA are separate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const config = read('Config/Base.xcconfig');
assert.match(config, /^REVENUECAT_API_KEY = appl_[A-Za-z0-9]+$/m);
assert.match(config, /^RELAY_SCHEME = wss$/m);
assert.match(read('TikTokForWork/App/RevenueCatConfig.swift'), /com\.honmaru\.ai\.pro\.monthly/);
assert.match(read('TikTokForWork/App/RevenueCatConfig.swift'), /com\.honmaru\.ai\.pro\.yearly/);
assert.match(read('TikTokForWork/Services/DictationService.swift'), /requiresOnDeviceRecognition = true/);
assert.doesNotMatch(read('TikTokForWork/Services/VideoRecorder.swift'), /for: \.audio/);
assert.doesNotMatch(read('TikTokForWork/PrivacyInfo.xcprivacy'), /NSPrivacyCollectedDataTypeAudioData/);
assert.match(read('TikTokForWork/Features/Subscription/ProPaywallSheet.swift'), /Link\("Terms of Use"/);
assert.match(read('TikTokForWork/Features/Subscription/ProPaywallSheet.swift'), /Link\("Privacy Policy"/);
const composer = read('TikTokForWork/Features/Feed/RequestComposerView.swift');
assert.match(composer, /Prepare without AI/);
assert.match(composer, /Your text, including any transcript, and relevant team context will be sent to our AI provider, OpenAI\. Microphone audio is not sent\./);
assert.match(composer, /allowAI: true/);
assert.match(read('TikTokForWork/ViewModels/FeedViewModel.swift'), /allowAI: Bool = false/);
const strings = JSON.parse(read('TikTokForWork/Localizable.xcstrings'));
for (const locale of ['ja', 'es', 'fr', 'de']) {
  assert.ok(strings.strings['Use AI to draft this request?'].localizations[locale]);
}
assert.match(read('web-react/public/privacy.html'), /端末内だけで文字起こし/);
assert.match(read('project.yml'), /APNS_ENVIRONMENT: production/);
console.log('PASS release configuration, legal links, on-device audio policy, and AI disclosure');
