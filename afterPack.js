const { execSync } = require('child_process');
const fs = require('fs');

exports.default = async function (context) {
  const dir = context.appOutDir;
  console.log('[afterPack] Stripping resource forks from:', dir);
  execSync(`xattr -cr "${dir}"`);
  execSync(`dot_clean -m "${dir}"`);
  fs.writeFileSync('/tmp/afterpack-ran.txt', dir);
  console.log('[afterPack] Done.');
};
