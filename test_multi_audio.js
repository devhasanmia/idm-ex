const { Ytdl } = require('@distube/ytdl-core');

async function checkMultiAudio() {
  const ytdl = new Ytdl();
  // MrBeast video with many audio languages
  const url = 'https://www.youtube.com/watch?v=0e3GPea1Tyg';
  console.log('Fetching info for MrBeast video...');
  const info = await ytdl.getInfo(url);
  const audioFormats = (info.formats || []).filter(f => f.hasAudio && !f.hasVideo);
  console.log('Audio formats count:', audioFormats.length);

  audioFormats.forEach((f, i) => {
    console.log(`[#${i}] itag: ${f.itag}, container: ${f.container}, bitrate: ${f.audioBitrate}`);
    console.log(`     audioTrack:`, f.audioTrack);
    console.log(`     audioQuality:`, f.audioQuality);
    console.log(`     language:`, f.language);
    console.log(`     loudnessDb:`, f.loudnessDb);
  });
}

checkMultiAudio().catch(console.error);
