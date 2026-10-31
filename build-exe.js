const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

console.log('📦 Step 1: Bundling UI, Browser Extension, and Media Muxer into embedded_assets.js...');

const uiHtml = fs.readFileSync(path.join(__dirname, 'src', 'server', 'ui.html'), 'utf8');
const mergePs1 = fs.existsSync(path.join(__dirname, 'merge_media.ps1'))
  ? fs.readFileSync(path.join(__dirname, 'merge_media.ps1'), 'utf8')
  : '';

const extDir = path.join(__dirname, 'extension');
const extFiles = {};
if (fs.existsSync(extDir)) {
  for (const file of fs.readdirSync(extDir)) {
    const full = path.join(extDir, file);
    if (fs.statSync(full).isFile()) {
      extFiles[file] = fs.readFileSync(full, 'utf8');
    }
  }
}

const outputJs = `// Auto-generated embedded assets for standalone Downly.exe
module.exports = {
  UI_HTML: ${JSON.stringify(uiHtml)},
  MERGE_MEDIA_PS1: ${JSON.stringify(mergePs1)},
  EXTENSION_FILES: ${JSON.stringify(extFiles, null, 2)}
};
`;

fs.writeFileSync(path.join(__dirname, 'embedded_assets.js'), outputJs, 'utf8');
console.log('✅ embedded_assets.js generated.');

console.log('🚀 Step 2: Compiling standalone Downly.exe (with hidden console)...');
execSync(
  'bun build idm.js --compile --windows-hide-console --windows-title="Downly" --windows-description="Downly Smart Download Manager" --outfile Downly.exe',
  { stdio: 'inherit', cwd: __dirname }
);
console.log('🎉 Successfully built standalone Downly.exe!');
