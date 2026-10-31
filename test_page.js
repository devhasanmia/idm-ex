const https = require('https');

async function testPageHtml() {
  const html = await new Promise((resolve, reject) => {
    https.get('https://www.youtube.com/watch?v=0e3GPea1Tyg', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });

  // Check for ytInitialPlayerResponse
  const match = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      console.log('Captions audio tracks:', data.captions?.playerCaptionsTracklistRenderer?.audioTracks);
    } catch (e) {
      console.log('JSON parse error:', e.message);
    }
  } else {
    console.log('No ytInitialPlayerResponse match');
  }
}

testPageHtml().catch(console.error);
