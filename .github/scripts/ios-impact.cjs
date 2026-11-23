const fs = require('node:fs');

const IOS_AFFECTING_PATHS = [
  /^TikTokForWork\//,
  /^apps\/mobile\//,
  /^packages\/(?:core|protocol)\//,
  /\.xcodeproj\//,
  /^VERSION$/,
  /^package(?:-lock)?\.json$/,
  /^scripts\/(?:check-versions|verify)\./,
  /^(?:project|Project)\.(?:yml|swift)$/,
];

function affectsIos(paths) {
  return paths.some((path) => IOS_AFFECTING_PATHS.some((pattern) => pattern.test(path)));
}

if (require.main === module) {
  const paths = fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean);
  process.stdout.write(`required=${affectsIos(paths)}\n`);
}

module.exports = {affectsIos};
