const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'dist', 'Atlas-Setup-1.3.2.exe');
const fileName = 'Atlas-Setup-1.3.2.exe';

// Step 1: Get server
https.get('https://api.gofile.io/servers', (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const server = JSON.parse(data).data.servers[0].name;
    console.log('Using server:', server);
    uploadFile(server);
  });
});

function uploadFile(server) {
  const boundary = '----FormBoundary' + Date.now();
  const fileSize = fs.statSync(filePath).size;
  console.log('File size:', (fileSize / 1024 / 1024).toFixed(1), 'MB');

  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const totalLength = header.length + fileSize + footer.length;

  const options = {
    hostname: `${server}.gofile.io`,
    port: 443,
    path: '/contents/uploadfile',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': totalLength
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('Response:', data);
      try {
        const json = JSON.parse(data);
        if (json.status === 'ok') {
          console.log('\n=== DOWNLOAD LINK ===');
          console.log(json.data.downloadPage);
          console.log('=====================');
        }
      } catch(e) {
        console.log('Parse error:', e.message);
      }
    });
  });

  req.on('error', e => console.error('Upload error:', e.message));

  // Write header, stream file, write footer
  req.write(header);
  const stream = fs.createReadStream(filePath);
  let uploaded = 0;
  stream.on('data', (chunk) => {
    uploaded += chunk.length;
    const pct = ((uploaded / fileSize) * 100).toFixed(1);
    process.stdout.write(`\rUploading: ${pct}%`);
    req.write(chunk);
  });
  stream.on('end', () => {
    console.log('\nUpload complete, waiting for response...');
    req.end(footer);
  });
}
