const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP_PATH = path.join(__dirname, 'dist', 'mac-arm64', 'Evolup Importer.app');
const DMG_PATH = path.join(__dirname, 'dist', 'Evolup Importer.dmg');

if (!fs.existsSync(APP_PATH)) {
  console.error('App not found at:', APP_PATH);
  process.exit(1);
}

if (fs.existsSync(DMG_PATH)) fs.unlinkSync(DMG_PATH);

console.log('Creating DMG (unsigned)...');
execSync(
  `hdiutil create -volname "Evolup Importer" -srcfolder "${APP_PATH}" -ov -format UDZO "${DMG_PATH}"`,
  { stdio: 'inherit' }
);

console.log('\n✓ DMG created at:', DMG_PATH);
console.log('\nNote: This is an unsigned app. To open it on macOS:');
console.log('  Right-click the app → Open → Open (to bypass Gatekeeper)');
console.log('  Or run: xattr -d com.apple.quarantine "/Applications/Evolup Importer.app"');
