/**
 * Create a GitHub release and upload the exe as an asset.
 * Uses the GitHub REST API.
 * 
 * Usage: GITHUB_TOKEN=<token> node scripts/github-release.js
 * 
 * The token needs repo scope. Get one from:
 *   https://github.com/settings/tokens/new?scopes=repo&description=atlas-release
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const OWNER = 'anymousxe';
const REPO = 'atlas';
const VERSION = require('../package.json').version;
const TAG = `v${VERSION}`;
const EXE_PATH = path.join(__dirname, '..', 'dist', `Atlas-Setup-${VERSION}.exe`);
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  console.error('ERROR: Set GITHUB_TOKEN environment variable');
  console.error('Get one at: https://github.com/settings/tokens/new?scopes=repo&description=atlas-release');
  process.exit(1);
}

if (!fs.existsSync(EXE_PATH)) {
  console.error(`ERROR: ${EXE_PATH} not found. Run npm run build first.`);
  process.exit(1);
}

function request(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { method, hostname, path, headers: { 'User-Agent': 'atlas-release', ...headers } };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function uploadBinary(hostname, uploadPath, headers, filePath) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const opts = {
      method: 'POST',
      hostname,
      path: uploadPath,
      headers: {
        'User-Agent': 'atlas-release',
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        ...headers
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    
    const stream = fs.createReadStream(filePath);
    let uploaded = 0;
    stream.on('data', (chunk) => {
      uploaded += chunk.length;
      process.stdout.write(`\rUploading: ${(uploaded / stat.size * 100).toFixed(1)}%`);
    });
    stream.pipe(req);
  });
}

async function main() {
  const auth = { Authorization: `token ${TOKEN}`, Accept: 'application/vnd.github.v3+json' };
  
  // Check if release already exists
  console.log(`Checking for existing release ${TAG}...`);
  const existing = await request('GET', 'api.github.com', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, auth);
  
  let release;
  if (existing.status === 200) {
    console.log(`Release ${TAG} already exists (id: ${existing.data.id}). Will upload asset to it.`);
    release = existing.data;
    
    // Delete existing exe asset if present
    if (release.assets?.length) {
      for (const asset of release.assets) {
        if (asset.name.endsWith('.exe')) {
          console.log(`Deleting existing asset: ${asset.name}`);
          await request('DELETE', 'api.github.com', `/repos/${OWNER}/${REPO}/releases/assets/${asset.id}`, auth);
        }
      }
    }
  } else {
    // Create release
    console.log(`Creating release ${TAG}...`);
    const createRes = await request('POST', 'api.github.com', `/repos/${OWNER}/${REPO}/releases`, auth, {
      tag_name: TAG,
      target_commitish: 'dev',
      name: `Atlas ${TAG}`,
      body: `## Atlas ${TAG}\n\nAuto-update enabled. Download and run the installer.\n\n### Changes\n- Fixed LiteRouter models not executing delete/remove/move tool calls\n- Improved fallback tool call extraction\n- Expanded intent detection for all tool types\n- Auto-update feed configured`,
      draft: false,
      prerelease: false
    });
    
    if (createRes.status !== 201) {
      console.error('Failed to create release:', createRes.status, createRes.data);
      process.exit(1);
    }
    release = createRes.data;
    console.log(`Release created: ${release.html_url}`);
  }

  // Upload exe
  const fileName = `Atlas-Setup-${VERSION}.exe`;
  const uploadUrl = `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`;
  console.log(`Uploading ${fileName} (${(fs.statSync(EXE_PATH).size / 1024 / 1024).toFixed(1)} MB)...`);
  
  const uploadRes = await uploadBinary('uploads.github.com', uploadUrl, {
    ...auth,
    Accept: 'application/vnd.github.v3+json'
  }, EXE_PATH);
  
  if (uploadRes.status === 201) {
    console.log(`\nAsset uploaded: ${uploadRes.data.browser_download_url}`);
    console.log(`\n=== DOWNLOAD URL ===`);
    console.log(uploadRes.data.browser_download_url);
    console.log(`====================`);
  } else {
    console.error('\nUpload failed:', uploadRes.status, uploadRes.data);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
