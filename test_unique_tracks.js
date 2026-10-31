const { Ytdl } = require('@distube/ytdl-core');

async function checkTracks() {
  const ytdl = new Ytdl();
  const url = 'https://www.youtube.com/watch?v=0e3GPea1Tyg';
  const info = await ytdl.getInfo(url);
  const audioFormats = (info.formats || []).filter(f => f.hasAudio && !f.hasVideo);

  const trackMap = new Map();
  for (const f of audioFormats) {
    if (f.audioTrack) {
      const key = f.audioTrack.id || f.audioTrack.displayName;
      if (!trackMap.has(key)) {
        trackMap.set(key, {
          id: f.audioTrack.id,
          name: f.audioTrack.displayName,
          isDefault: !!f.audioTrack.audioIsDefault
        });
      }
    }
  }

  console.log('Unique audio tracks (count=' + trackMap.size + '):');
  for (const [k, v] of trackMap.entries()) {
    console.log(v);
  }
}

checkTracks().catch(console.error);
