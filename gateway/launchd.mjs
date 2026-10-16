// Pure plist rendering: token contents never enter launchd arguments or logs.
export const SERVICE_LABEL = 'com.honmaru.gateway';
const escape = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function servicePlist({ node, service, config, directory, home }) {
  for (const path of [node, service, config, directory, home]) if (typeof path !== 'string' || !path.startsWith('/') || /[\u0000-\u001f]/.test(path)) throw new Error('Absolute local paths required.');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${[node, service, config].map(s => `<string>${escape(s)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${escape(home)}</string></dict>
<key>WorkingDirectory</key><string>${escape(directory)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>20</integer>
<key>StandardOutPath</key><string>${escape(directory)}/service.log</string>
<key>StandardErrorPath</key><string>${escape(directory)}/service-error.log</string>
</dict></plist>\n`;
}
