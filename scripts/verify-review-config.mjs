// Small, offline release-regression gate. Runtime and device QA are separate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
// Pin the approved Figma logo so a main/release merge cannot silently restore
// the old card-stack placeholder while the in-app mark is already updated.
const appIcon = readFileSync(new URL('TikTokForWork/Assets.xcassets/AppIcon.appiconset/AppIcon.png', root));
assert.equal(createHash('sha256').update(appIcon).digest('hex'),
  '24abcc3c1e0b58ecef60bc7fbbfb3ea7662b057e7beb677ff59e344bd01269ee',
  'AppIcon must use the approved Figma 590:143 logo');
assert.equal(appIcon.readUInt32BE(16), 1024);
assert.equal(appIcon.readUInt32BE(20), 1024);
assert.equal(appIcon[25], 2, 'App Store icon must be RGB without alpha');
const appIconSet = JSON.parse(read('TikTokForWork/Assets.xcassets/AppIcon.appiconset/Contents.json'));
assert.ok(appIconSet.images.some(image => image.filename === 'AppIcon.png' && image.size === '1024x1024'));
console.log('PASS release configuration, legal links, on-device audio policy, and AI disclosure');
console.log('PASS approved 1024px opaque AppIcon');
