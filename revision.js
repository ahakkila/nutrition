const fs = require('node:fs');

const versionFile = 'version.json';
const revision = JSON.parse(fs.readFileSync(versionFile, 'utf8'));

const now = new Date();
const timestamp = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
  String(now.getHours()).padStart(2, '0'),
  String(now.getMinutes()).padStart(2, '0'),
  String(now.getSeconds()).padStart(2, '0')
].join('');

const updated = { ...revision, timestamp };
fs.writeFileSync(versionFile, `${JSON.stringify(updated, null, 2)}\n`);
console.log(`Updated version.json: v${updated.version} · ${updated.timestamp}`);
